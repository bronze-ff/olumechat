// Testes da migração de contato no system/user_changed_number (cliente trocou de número).
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

// Payload REAL do user_changed_number: `from` E `system.wa_id` trazem o número NOVO;
// o ANTIGO (8888) só aparece no texto `system.body` ("...changed from X to Y").
function payloadSystem() {
  return { entry: [{ changes: [{ value: {
    metadata: { phone_number_id: '1112223334', display_phone_number: '556237731090' },
    messages: [{
      id: 'wamid.SYS1', from: '5562955554444', timestamp: '1718000000',
      type: 'system', system: {
        type: 'user_changed_number', wa_id: '5562955554444',
        body: 'User A changed from 5562988887777 to 5562955554444',
      },
    }],
  } }] }] };
}

// acharContato consulta `... TELEFONE IN (variantes)`; distingo antigo (8888) do novo (5555) pelos binds.
function fakeConnMig({ capturas, contatoNovoExiste = false }) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM MC_ZAP_NUMERO')) return { rows: [{ ID: 2, DEPARTAMENTO_PADRAO_ID: null, FLUXO_ID: null }] };
      if (sql.includes('FROM MC_ZAP_CONTATO') && sql.includes('TELEFONE IN')) {
        const vals = Object.values(binds || {}).join(',');
        if (vals.includes('8888')) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] }; // antigo
        return { rows: contatoNovoExiste ? [{ ID: 9, NOME_PERFIL: 'Outro' }] : [] };      // novo
      }
      if (sql.includes('FROM MC_ZAP_CONVERSA')) return { rows: [{ ID: 70 }] };
      return { rows: [], outBinds: {}, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('user_changed_number migra o contato (UPDATE TELEFONE + auditoria + nota) e não grava a system como inbound', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConnMig({ capturas });
  await processPayload(payloadSystem());
  const sqls = capturas.map((c) => c.sql);
  assert.ok(sqls.some((s) => /UPDATE MC_ZAP_CONTATO SET TELEFONE/.test(s)), 'deve migrar o TELEFONE');
  assert.ok(sqls.some((s) => /migracao_numero'/.test(s)), 'deve auditar a migração');
  assert.ok(sqls.some((s) => /INSERT INTO MC_ZAP_MENSAGEM/.test(s) && /'nota'/.test(s)), 'deve registrar nota na conversa');
  assert.ok(!sqls.some((s) => /INSERT INTO MC_ZAP_MENSAGEM/.test(s) && /'in'/.test(s)), 'não grava a system como mensagem inbound');
});

test('número novo já existe em outro contato → conflito auditado, sem sobrescrever', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConnMig({ capturas, contatoNovoExiste: true });
  await processPayload(payloadSystem());
  const sqls = capturas.map((c) => c.sql);
  assert.ok(sqls.some((s) => /migracao_numero_conflito/.test(s)), 'deve auditar o conflito');
  assert.ok(!sqls.some((s) => /UPDATE MC_ZAP_CONTATO SET TELEFONE/.test(s)), 'não sobrescreve o telefone no conflito');
});
