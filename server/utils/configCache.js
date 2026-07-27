// utils/configCache.js — Leitura de `config` com cache em memória (60s), por tenant.
// Usado no caminho quente do webhook (toda mensagem recebida) — uma ida ao
// banco por minuto POR TENANT, não por mensagem. Recebe a conexão já aberta do
// chamador (dentro de comTenant) e o tenantId chaveia o cache.
//
// CONTRATO: tenantId é OBRIGATÓRIO em toda chamada de lerConfig — não existe
// balde 'default'. Um balde compartilhado sem tenant na chave é vazamento de
// configuração entre clientes (exatamente o que este ticket, FIL-66, existe
// para fechar), e a invalidação por tenant do api/config.js não teria como
// atingir um balde global. `lerConfig(undefined, conn)` lança erro em vez de
// cair num cache genérico.
//
// Chamadores ainda não portados (`bot/runtime.js`, `webhook/processEvent.js`
// — escopo do FIL-62/FIL-60) hoje chamam `lerConfig(conn)` com um único
// argumento; sob este contrato isso é tenantId inválido e lança. Esperado:
// esses módulos adaptam o call site para `lerConfig(req/contexto.tenantId,
// conn)` quando forem portados — não é papel deste arquivo inventar um
// tenant substituto para eles.
'use strict';

const TTL_MS = 60_000;
const cache = new Map(); // tenantId normalizado (string) -> { valor, exp }

function normalizarTenantId(tenantId) {
  const id = Number(tenantId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`lerConfig: tenantId inválido: ${JSON.stringify(tenantId)}`);
  }
  return String(id);
}

async function lerConfig(tenantId, conn) {
  const chave = normalizarTenantId(tenantId);
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

/** Invalida o cache de um tenant; sem argumento, limpa tudo (uso em teste/admin). */
function invalidar(tenantId) {
  if (tenantId === undefined) cache.clear();
  else cache.delete(String(Number(tenantId)));
}

module.exports = { lerConfig, invalidar };
