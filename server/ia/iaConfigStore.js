// server/ia/iaConfigStore.js — resolve a config ativa do provedor de IA para
// um tenant. FIL-78: a credencial deixou de ser só por tenant — a ordem de
// resolução é (1) chave PRÓPRIA do tenant em ia_config, se existir e ativa
// (compat com quem já migrou antes do FIL-78); senão (2) a credencial GLOBAL
// do operador (provedor_credencial, migração 015).
//
// ⚠️ SEM `conn`: carregar(tenantId) NÃO recebe a conexão de tenant do
// chamador. Resolve tudo (chave própria E credencial global) NUMA ÚNICA
// transação de operador (operador/db.js::comOperador, BYPASSRLS, tenant_id
// sempre explícito nas queries — mesmo padrão de
// operador/tenants.js::carregarIaConfig), porque `provedor_credencial` é
// fechada pra `falatta_app` (RLS deny, migração 015) e a query de ia_config
// própria do tenant é redundante fazer duas vezes.
//
// Por isso: SEMPRE chame carregar(tenantId) FORA de um db.comTenant() em
// andamento. Achado de review do FIL-78: buscar a credencial global com uma
// SEGUNDA conexão (comOperador) enquanto o chamador ainda segurava a conexão
// de tenant (db.comTenant) esgotava o pool sob concorrência — cada
// requisição podia prender 2 conexões simultâneas em vez de 1. Ver
// ia/runtime.js e api/conversas.js: a credencial é resolvida numa fase
// própria, entre duas transações de tenant (ou antes/depois de uma única).
//
// Cache com TTL 60s, chaveado por tenant (FIL-63: um cache global vazaria a
// config de um tenant pro outro) + uma chave reservada para a credencial
// global, invalidada separadamente (invalidarGlobal).
'use strict';
const { descriptografar } = require('./crypto');
const { comOperador } = require('../operador/db');
const credencialIa = require('../operador/credencialIa');

const TTL_MS = 60_000;
const cache = new Map(); // tenantId (string) -> { valor, exp }
const CHAVE_GLOBAL = '__operador__';

async function lerConfigDoTenant(conn, tenantId) {
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

/** Resolve tudo NUMA ÚNICA conexão de operador — chave própria do tenant
 *  primeiro, credencial global depois (com seu próprio cache, TTL 60s,
 *  pra não reconsultar provedor_credencial a cada tenant sem chave própria). */
async function resolver(tenantId) {
  return comOperador(async (conn) => {
    const doTenant = await lerConfigDoTenant(conn, tenantId);
    if (doTenant) return doTenant;

    const hit = cache.get(CHAVE_GLOBAL);
    if (hit && hit.exp > Date.now()) return hit.valor;
    const global = await credencialIa.lerAtivaComChave(conn);
    cache.set(CHAVE_GLOBAL, { valor: global, exp: Date.now() + TTL_MS });
    return global;
  });
}

/**
 * Config ativa do tenant (própria ou, na falta dela, a global do operador).
 * NÃO recebe `conn` — abre sua própria transação de operador. Chame SEMPRE
 * fora de um db.comTenant() em andamento (ver cabeçalho do arquivo).
 */
async function carregar(tenantId) {
  const chave = String(tenantId);
  const hit = cache.get(chave);
  if (hit && hit.exp > Date.now()) return hit.valor;
  const valor = await resolver(tenantId);
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
