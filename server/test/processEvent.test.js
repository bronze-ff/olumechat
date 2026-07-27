// Testes do processPayload com a FILA (Fase 5B): roteamento por departamento
// padrão do número, protocolo e a REGRESSÃO crítica — renovar janela não pode
// tocar FILA_STATUS.
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
const { subscribe } = require('../realtime/hub');

function payloadInbound() {
  return {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '1112223334', display_phone_number: '556237731090' },
          contacts: [{ wa_id: '5562999990000', profile: { name: 'Cliente' } }],
          messages: [{ id: 'wamid.IN1', from: '5562999990000', timestamp: '1718000000', type: 'text', text: { body: 'oi' } }],
        },
      }],
    }],
  };
}

function fakeConn({ deptoDoNumero = null, conversaExistente = null, capturas = [] }) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM MC_ZAP_NUMERO')) {
        return { rows: [{ ID: 2, DEPARTAMENTO_PADRAO_ID: deptoDoNumero, FLUXO_ID: null }] };
      }
      if (sql.includes('FROM MC_ZAP_CONTATO')) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] };
      if (sql.includes('FROM MC_ZAP_CONVERSA')) {
        return { rows: conversaExistente ? [conversaExistente] : [] };
      }
      if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260610100042' }] };
      if (sql.startsWith('INSERT INTO MC_ZAP_CONVERSA')) return { outBinds: { id: [70] } };
      return { rows: [], outBinds: {}, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('conversa NOVA em número COM depto → entra na fila com protocolo + evento fila', async () => {
  presence._reset(); // ninguém online: distribuidor não mexe no banco
  const capturas = [];
  db.getConnection = async () => fakeConn({ deptoDoNumero: 4, capturas });

  const eventos = [];
  const off = subscribe((e) => eventos.push(e));
  await processPayload(payloadInbound());
  off();

  const insConversa = capturas.find((c) => c.sql.startsWith('INSERT INTO MC_ZAP_CONVERSA'));
  assert.equal(insConversa.binds.fst, 'aguardando');
  assert.equal(insConversa.binds.dep, 4);
  assert.equal(insConversa.binds.prot, '260610100042');
  assert.match(insConversa.sql, /SYSTIMESTAMP/); // FILA_ENTROU_EM

  const fila = eventos.find((e) => e.tipo === 'fila');
  assert.equal(fila.departamentoId, 4);
  assert.equal(fila.protocolo, '260610100042');
});

test('conversa NOVA em número SEM depto → em_atendimento, sem protocolo nem evento fila', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConn({ deptoDoNumero: null, capturas });

  const eventos = [];
  const off = subscribe((e) => eventos.push(e));
  await processPayload(payloadInbound());
  off();

  const ins = capturas.find((c) => c.sql.startsWith('INSERT INTO MC_ZAP_CONVERSA'));
  assert.equal(ins.binds.fst, 'em_atendimento');
  assert.equal(ins.binds.prot, null);
  assert.equal(eventos.some((e) => e.tipo === 'fila'), false);
});

test('REGRESSÃO: renovar janela de conversa existente NÃO toca FILA_STATUS', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConn({
    deptoDoNumero: 4,
    conversaExistente: { ID: 50, DEPARTAMENTO_ID: 4 },
    capturas,
  });

  await processPayload(payloadInbound());

  const upd = capturas.find((c) => c.sql.startsWith('UPDATE MC_ZAP_CONVERSA'));
  assert.ok(upd, 'deve renovar a conversa existente');
  assert.equal(/FILA_STATUS/.test(upd.sql), false);   // não mexe no ciclo do atendimento
  assert.equal(/PROTOCOLO/.test(upd.sql), false);     // não gera protocolo novo
  assert.equal(capturas.some((c) => c.sql.startsWith('INSERT INTO MC_ZAP_CONVERSA')), false);
});
