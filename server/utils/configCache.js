// utils/configCache.js — Leitura de `config` com cache em memória (60s), por tenant.
// Usado no caminho quente do webhook (toda mensagem recebida) — uma ida ao
// banco por minuto POR TENANT, não por mensagem. Recebe a conexão já aberta do
// chamador (dentro de comTenant) e o tenantId só para chavear o cache: sem o
// tenant na chave, o valor cacheado de um cliente vazaria para outro
// (FIL-66) — cada tenant precisa da sua própria janela de 60s.
//
// `tenantId` é opcional: chamadores que ainda não passam tenant (módulos não
// portados) caem no balde 'default', preservando o comportamento anterior
// (um cache só) até serem portados.
'use strict';

const TTL_MS = 60_000;
const cache = new Map(); // tenantId (string) -> { valor, exp }

async function lerConfig(conn, tenantId) {
  const chave = String(tenantId ?? 'default');
  const item = cache.get(chave);
  if (item && item.exp > Date.now()) return item.valor;
  try {
    const r = await conn.execute(`SELECT chave, valor FROM config`);
    const out = {};
    for (const row of r.rows) out[row.CHAVE] = row.VALOR;
    cache.set(chave, { valor: out, exp: Date.now() + TTL_MS });
    return out;
  } catch (err) {
    // Tabela ainda não criada (migração pendente): segue sem config.
    if (err.code === '42P01') return {};
    throw err;
  }
}

/** Invalida o cache de um tenant; sem argumento, limpa tudo. */
function invalidar(tenantId) {
  if (tenantId === undefined) cache.clear();
  else cache.delete(String(tenantId));
}

module.exports = { lerConfig, invalidar };
