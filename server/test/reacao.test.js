// Testes do comportamento de REAÇÃO (emoji): só registra se já houver conversa aberta;
// nunca cria atendimento novo nem entra na fila.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const presence = require('../realtime/presence');
const { processPayload } = require('../webhook/processEvent');

function payloadReacao() {
  return { entry: [{ changes: [{ value: {
    metadata: { phone_number_id: '1112223334', display_phone_number: '556237731090' },
    contacts: [{ wa_id: '5562999990000', profile: { name: 'Cliente' } }],
    messages: [{
      id: 'wamid.R1', from: '5562999990000', timestamp: '1718000000',
      type: 'reaction', reaction: { message_id: 'wamid.PREV', emoji: '🤝' },
    }],
  } }] }] };
}

function fakeConnReacao({ capturas, aberta }) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM numero')) return { rows: [{ ID: 2, TENANT_ID: 1, DEPARTAMENTO_PADRAO_ID: 4, MODO: 'padrao', FLUXO_ID: null }] };
      // Guarda da reação (SELECT 1 ...) — vem ANTES do select genérico de conversa.
      if (sql.includes('SELECT 1 FROM conversa')) return { rows: aberta ? [{ '1': 1 }] : [] };
      if (sql.includes('FROM MC_ZAP_CONTATO')) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] };
      if (sql.includes('FROM conversa')) {
        return { rows: aberta ? [{ ID: 70, DEPARTAMENTO_ID: 4, FILA_STATUS: 'em_atendimento', PROTOCOLO: 'P1', AVISO_FORA_HORARIO: 'N' }] : [] };
      }
      return { rows: [], outBinds: { id: [99] }, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('reação SEM conversa aberta é ignorada (não cria atendimento nem grava mensagem)', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConnReacao({ capturas, aberta: false });
  await processPayload(payloadReacao());
  const sqls = capturas.map((c) => c.sql);
  assert.ok(!sqls.some((s) => /INSERT INTO mensagem/.test(s)), 'não grava a reação');
  assert.ok(!sqls.some((s) => /INSERT INTO conversa/.test(s)), 'não cria conversa');
});

test('reação COM conversa aberta é registrada (sem criar conversa)', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConnReacao({ capturas, aberta: true });
  await processPayload(payloadReacao());
  const sqls = capturas.map((c) => c.sql);
  assert.ok(sqls.some((s) => /INSERT INTO mensagem/.test(s)), 'registra a reação na conversa aberta');
  assert.ok(!sqls.some((s) => /INSERT INTO conversa/.test(s)), 'reaproveita a conversa, não cria nova');
});
