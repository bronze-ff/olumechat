// Testes do sweeper de timeout do bot (bot/sweeper.js).
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const runtime = require('../bot/runtime');
const sweeper = require('../bot/sweeper');

/** ctxTenant simula o set_config(...) do comTenant() real: é dele que o
    "banco" deriva qual tenant está sendo varrido no momento. */
function criarConnFalso(dadosPorTenant) {
  let ctxTenant = null;
  return {
    async execute(sql, binds = {}) {
      if (/set_config/i.test(sql)) { ctxTenant = binds.tid; return { rows: [] }; }
      if (/^SET LOCAL ROLE/i.test(sql)) return { rows: [] };
      if (sql.includes("FROM tenant WHERE status = 'ativo'")) return { rows: [{ ID: 1 }, { ID: 2 }] };
      if (sql.includes('FROM conversa c')) return { rows: dadosPorTenant[ctxTenant] || [] };
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('varrer: expira conversas paradas, respeitando timeoutMin do fluxo por tenant', async () => {
  const conn = criarConnFalso({
    '1': [
      { ID: 101, DEFINICAO: { config: { timeoutMin: 5 } }, PARADA_MIN: 10 }, // 10 >= 5: expira
      { ID: 102, DEFINICAO: { config: { timeoutMin: 20 } }, PARADA_MIN: 10 }, // 10 < 20: não expira
    ],
    '2': [
      { ID: 201, DEFINICAO: { config: { timeoutMin: 60 } }, PARADA_MIN: 90 }, // 90 >= 60: expira
    ],
  });
  db.getConnection = async () => conn;
  const chamadas = [];
  const original = runtime.expirar;
  runtime.expirar = (tenantId, conversaId) => { chamadas.push([tenantId, conversaId]); };
  try {
    await sweeper.varrer();
    assert.deepEqual(chamadas.sort(), [[1, 101], [2, 201]].sort());
  } finally {
    runtime.expirar = original;
  }
});

test('varrer: timeoutMin malformado ou ausente cai no padrão de 30min em vez de abortar a query', async () => {
  const conn = criarConnFalso({
    '1': [
      { ID: 301, DEFINICAO: { config: { timeoutMin: 'trinta' } }, PARADA_MIN: 40 }, // texto não numérico: padrão 30, 40>=30 expira
      { ID: 302, DEFINICAO: { config: { timeoutMin: 'trinta' } }, PARADA_MIN: 10 }, // 10 < 30: não expira
      { ID: 303, DEFINICAO: { config: {} }, PARADA_MIN: 45 }, // sem timeoutMin: padrão 30, expira
      { ID: 304, DEFINICAO: { config: { timeoutMin: -5 } }, PARADA_MIN: 45 }, // negativo: padrão 30, expira
      { ID: 305, DEFINICAO: {}, PARADA_MIN: 45 }, // sem config nenhum: padrão 30, expira
    ],
    '2': [],
  });
  db.getConnection = async () => conn;
  const chamadas = [];
  const original = runtime.expirar;
  runtime.expirar = (tenantId, conversaId) => { chamadas.push([tenantId, conversaId]); };
  try {
    await sweeper.varrer(); // não deve lançar nem logar "sweeper falhou"
    assert.deepEqual(chamadas.map((c) => c[1]).sort((a, b) => a - b), [301, 303, 304, 305]);
  } finally {
    runtime.expirar = original;
  }
});

test('varrer: falha ao listar tenants não lança (só loga)', async () => {
  db.getConnection = async () => { throw new Error('sem conexão'); };
  await assert.doesNotReject(sweeper.varrer());
});

test('varrer: falha num tenant não impede a varredura dos demais', async () => {
  let chamadas = 0;
  const conn = {
    async execute(sql) {
      if (sql.includes("FROM tenant WHERE status = 'ativo'")) return { rows: [{ ID: 1 }, { ID: 2 }] };
      if (sql.includes('FROM conversa c')) {
        chamadas++;
        if (chamadas === 1) throw new Error('tabela indisponível pro tenant 1');
        return { rows: [] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  db.getConnection = async () => conn;
  await assert.doesNotReject(sweeper.varrer());
  assert.equal(chamadas, 2, 'deveria ter tentado os dois tenants mesmo com o primeiro falhando');
});
