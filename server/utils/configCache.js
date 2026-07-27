// utils/configCache.js — Leitura de MC_ZAP_CONFIG com cache em memória (60s).
// Usado no caminho quente do webhook (toda mensagem recebida) — uma ida ao
// banco por minuto, não por mensagem. Recebe a conexão já aberta do chamador.
'use strict';


const TTL_MS = 60_000;
let cache = null;
let exp = 0;

async function lerConfig(conn) {
  if (cache && exp > Date.now()) return cache;
  try {
    const r = await conn.execute(`SELECT CHAVE, VALOR FROM MC_ZAP_CONFIG`);
    const out = {};
    for (const row of r.rows) out[row.CHAVE] = row.VALOR;
    cache = out;
    exp = Date.now() + TTL_MS;
    return out;
  } catch (err) {
    // Tabela ainda não criada (script 05 pendente): segue sem config.
    if (err.errorNum === 942) return {};
    throw err;
  }
}

function invalidar() { cache = null; }

module.exports = { lerConfig, invalidar };
