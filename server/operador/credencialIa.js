// operador/credencialIa.js — credencial GLOBAL do operador para o provedor de
// IA (FIL-78: fim da chave por tenant). O operador é dono de UMA credencial
// ativa por vez (`provedor_credencial`, migração 015): o cliente compra "IA"
// como add-on do plano, nunca vê custo, tokens, modelo ou chave.
//
// MESMO PADRÃO DE ISOLAMENTO de operador/tenants.js: tudo aqui roda em
// comOperador() (contexto de tenant NULO, BYPASSRLS). `provedor_credencial` é
// FECHADA para o caminho de tenant (RLS deny + REVOKE, ver a migração 015) —
// mesmo um bug de código que tentasse ler via comTenant() receberia
// "permission denied", nunca uma linha.
//
// A CHAVE NUNCA SAI DAQUI EM CLARO: listarCredenciais() devolve só
// provider/modeloPadrao/baseUrl/ativo. Só carregarAtivaComChave() decifra, e
// ela é chamada exclusivamente por ia/iaConfigStore.js (o runtime do bot) —
// nunca por uma rota HTTP.
'use strict';

const { comOperador } = require('./db');
const auditoria = require('./auditoria');
const { ErroOperador } = require('./erroOperador');
const { validarProviderModeloBaseUrl } = require('./validacaoIa');
const { cifrar, decifrar } = require('../ia/credencialOperador');

/** Todas as credenciais já configuradas (histórico por provedor), sem a chave. */
async function listarCredenciais() {
  return comOperador(async (conn) => {
    let r;
    try {
      r = await conn.execute(
        `SELECT provider, modelo_padrao, base_url, ativo, atualizado_em FROM provedor_credencial ORDER BY provider`);
    } catch (err) {
      if (err.code === '42P01') return []; // migração 015 ainda não aplicada
      throw err;
    }
    return r.rows.map((row) => ({
      provider: row.PROVIDER,
      modeloPadrao: row.MODELO_PADRAO,
      baseUrl: row.BASE_URL,
      ativo: row.ATIVO === 'S',
      atualizadoEm: row.ATUALIZADO_EM,
    }));
  });
}

/**
 * Grava/atualiza a credencial de um provedor e a torna A ATIVA (só uma por
 * vez — é a que ia/iaConfigStore.js usa como fallback de todo tenant sem
 * chave própria). Mesma validação de operador/tenants.js::salvarIaConfig.
 */
async function salvarCredencial({ operador, provider, modeloPadrao, baseUrl, apiKey, ip }) {
  const v = validarProviderModeloBaseUrl({ provider, modelo: modeloPadrao, baseUrl });
  const temChaveNova = apiKey && String(apiKey).trim();

  return comOperador(async (conn) => {
    let cifrada;
    if (temChaveNova) {
      cifrada = cifrar(String(apiKey));
    } else {
      const ex = await conn.execute(
        `SELECT api_key_criptografada FROM provedor_credencial WHERE provider = :p`, { p: v.provider });
      cifrada = ex.rows.length ? ex.rows[0].API_KEY_CRIPTOGRAFADA : null;
      if (!cifrada) throw new ErroOperador(400, 'API key obrigatória na primeira configuração deste provedor.');
    }

    // Só uma credencial ativa por vez (ux_predcred_ativo_unico) — desativa as
    // outras ANTES do upsert desta, senão o índice único parcial rejeita.
    await conn.execute(`UPDATE provedor_credencial SET ativo = 'N' WHERE provider <> :p AND ativo = 'S'`, { p: v.provider });
    await conn.execute(
      `INSERT INTO provedor_credencial (provider, modelo_padrao, base_url, api_key_criptografada, ativo, atualizado_em)
       VALUES (:p, :m, :b, :k, 'S', now())
       ON CONFLICT (provider) DO UPDATE SET
         modelo_padrao = EXCLUDED.modelo_padrao, base_url = EXCLUDED.base_url,
         api_key_criptografada = EXCLUDED.api_key_criptografada, ativo = 'S', atualizado_em = now()`,
      { p: v.provider, m: v.modelo, b: v.baseUrl, k: cifrada });

    // NUNCA a chave em claro no detalhe da auditoria — só o metadado.
    await auditoria.registrar(conn, {
      operador, tenantId: null, acao: 'credencial_operador_alterada',
      entidade: 'provedor_credencial', entidadeId: null,
      detalhe: { provider: v.provider, modeloPadrao: v.modelo, baseUrl: v.baseUrl, chaveTrocada: !!temChaveNova }, ip,
    });
    return { provider: v.provider, modeloPadrao: v.modelo, baseUrl: v.baseUrl, ativo: true };
  });
}

/**
 * A credencial ativa, COM a chave decifrada, usando uma conexão de operador
 * JÁ ABERTA (`conn`) — NÃO abre transação própria. Único ponto de leitura da
 * chave em claro no processo inteiro. Se a decifragem falhar (segredo
 * rotacionado, blob corrompido), devolve null em vez de derrubar o runtime —
 * mesmo racional do iaConfigStore de tenant.
 *
 * Existe separada de carregarAtivaComChave() para que ia/iaConfigStore.js
 * possa ler a config PRÓPRIA do tenant e a credencial GLOBAL na MESMA
 * transação de operador (uma só conexão) — ver o cabeçalho de
 * ia/iaConfigStore.js sobre por que abrir uma segunda conexão aqui seria o
 * mesmo defeito de conexão aninhada que a review pegou.
 */
async function lerAtivaComChave(conn) {
  let r;
  try {
    r = await conn.execute(
      `SELECT provider, modelo_padrao, base_url, api_key_criptografada FROM provedor_credencial WHERE ativo = 'S'`);
  } catch (err) {
    if (err.code === '42P01') return null; // migração 015 ainda não aplicada
    throw err;
  }
  if (!r.rows.length) return null;
  const row = r.rows[0];
  let apiKey;
  try {
    apiKey = decifrar(row.API_KEY_CRIPTOGRAFADA);
  } catch (e) {
    console.error('[ia] credencial global do operador não decifrável — reconfigure em /api/operador/ia-credencial:', e.message);
    return null;
  }
  return { provider: row.PROVIDER, modelo: row.MODELO_PADRAO, baseUrl: row.BASE_URL || null, apiKey };
}

/** Mesma coisa que lerAtivaComChave(), mas abrindo sua PRÓPRIA transação de
 *  operador — para quem não já está dentro de uma (ex.: chamada avulsa,
 *  script, teste). Runtime nunca deve usar esta: usa lerAtivaComChave(conn)
 *  dentro da transação que ia/iaConfigStore.js já abriu. */
async function carregarAtivaComChave() {
  return comOperador((conn) => lerAtivaComChave(conn));
}

module.exports = { listarCredenciais, salvarCredencial, carregarAtivaComChave, lerAtivaComChave };
