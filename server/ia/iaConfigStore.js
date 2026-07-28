// server/ia/iaConfigStore.js — resolve a config ativa do provedor de IA para
// um tenant. FIL-78: a credencial deixou de ser só por tenant — a ordem de
// resolução é (1) chave PRÓPRIA do tenant em ia_config, se existir e ativa
// (compat com quem já migrou antes do FIL-78); senão (2) a credencial GLOBAL
// do operador (provedor_credencial, migração 015).
//
// A consulta à credencial global NUNCA usa a `conn` do tenant (ela roda como
// `falatta_app`, e provedor_credencial é fechada pra esse role — ver a
// migração 015): passa por operador/credencialIa.js::carregarAtivaComChave(),
// que abre sua PRÓPRIA transação via operador/db.js::comOperador (BYPASSRLS,
// contexto de tenant nulo). É o mesmo motivo pelo qual o resto do sistema só
// toca dado cross-tenant por ali.
//
// Cache com TTL 60s, chaveado por tenant (FIL-63: um cache global vazaria a
// config de um tenant pro outro) + uma chave reservada para a credencial
// global, invalidada separadamente (invalidarGlobal).
'use strict';
const { descriptografar } = require('./crypto');
const credencialOperador = require('../operador/credencialIa');

const TTL_MS = 60_000;
const cache = new Map(); // tenantId (string) -> { valor, exp }
const CHAVE_GLOBAL = '__operador__';

async function carregarDoTenant(conn, tenantId) {
  try {
    const r = await conn.execute(
      `SELECT PROVIDER, MODELO, BASE_URL, API_KEY_CRIPTOGRAFADA
         FROM ia_config WHERE tenant_id = :tenantId AND ID = 1 AND ATIVO = 'S'`,
      { tenantId }
    );
    if (!r.rows || !r.rows.length) return null;
    const row = r.rows[0];
    // Falha de decifragem (IA_CRYPTO_KEY/JWT_SECRET mudou, blob corrompido) NÃO
    // pode propagar — senão o runtime morre em silêncio. Tratamos como "sem
    // chave própria" e caímos no fallback da credencial global do operador.
    try {
      return {
        provider: row.PROVIDER,
        modelo: row.MODELO,
        baseUrl: row.BASE_URL || null,
        apiKey: descriptografar(row.API_KEY_CRIPTOGRAFADA, tenantId),
      };
    } catch (e) {
      console.error('[ia] API key do tenant não decifrável — reconfigure o provedor no painel:', e.message);
      return null;
    }
  } catch (err) {
    if (err.code === '42P01') return null; // tabela ainda não criada (undefined_table)
    throw err;
  }
}

async function carregarGlobal() {
  const hit = cache.get(CHAVE_GLOBAL);
  if (hit && hit.exp > Date.now()) return hit.valor;
  let valor = null;
  try {
    valor = await credencialOperador.carregarAtivaComChave();
  } catch (e) {
    console.error('[ia] falha ao carregar a credencial global do operador:', e.message);
  }
  cache.set(CHAVE_GLOBAL, { valor, exp: Date.now() + TTL_MS });
  return valor;
}

async function carregar(conn, tenantId) {
  const chave = String(tenantId);
  const hit = cache.get(chave);
  if (hit && hit.exp > Date.now()) return hit.valor;

  const valor = (await carregarDoTenant(conn, tenantId)) || (await carregarGlobal());
  cache.set(chave, { valor, exp: Date.now() + TTL_MS });
  return valor;
}

/** Invalida o cache de um tenant (ou de todos, se tenantId omitido). Não
 *  afeta o cache da credencial global — ver invalidarGlobal(). */
function invalidar(tenantId) {
  if (tenantId === undefined) cache.clear();
  else cache.delete(String(tenantId));
}

/** Invalida só o cache da credencial global — chamada por
 *  operador/credencialIa.js::salvarCredencial após trocar a credencial. */
function invalidarGlobal() {
  cache.delete(CHAVE_GLOBAL);
}

module.exports = { carregar, invalidar, invalidarGlobal };
