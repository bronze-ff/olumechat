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
const runtime = require('../bot/runtime');

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
      if (sql.includes('FROM numero')) {
        return { rows: [{ ID: 2, TENANT_ID: 1, DEPARTAMENTO_PADRAO_ID: deptoDoNumero, MODO: 'padrao', FLUXO_ID: null }] };
      }
      if (sql.includes('FROM MC_ZAP_CONTATO')) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] };
      if (sql.includes('FROM conversa')) {
        return { rows: conversaExistente ? [conversaExistente] : [] };
      }
      if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260610100042' }] };
      if (sql.startsWith('INSERT INTO conversa')) return { outBinds: { id: [70] } };
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

  const insConversa = capturas.find((c) => c.sql.startsWith('INSERT INTO conversa'));
  assert.equal(insConversa.binds.fst, 'aguardando');
  assert.equal(insConversa.binds.dep, 4);
  assert.equal(insConversa.binds.prot, '260610100042');
  assert.match(insConversa.sql, /now\(\)/); // fila_entrou_em

  const fila = eventos.find((e) => e.tipo === 'fila');
  assert.equal(fila.departamentoId, 4);
  assert.equal(fila.protocolo, '260610100042');

  // Todo evento publicado precisa carregar o tenant resolvido do phone_number_id —
  // um receptor fail-closed (PR #7) descarta evento sem etiqueta de tenant.
  const mensagem = eventos.find((e) => e.tipo === 'mensagem');
  assert.equal(mensagem.tenantId, 1);
  assert.equal(fila.tenantId, 1);
});

test('conversa NOVA em número SEM depto → em_atendimento, sem protocolo nem evento fila', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConn({ deptoDoNumero: null, capturas });

  const eventos = [];
  const off = subscribe((e) => eventos.push(e));
  await processPayload(payloadInbound());
  off();

  const ins = capturas.find((c) => c.sql.startsWith('INSERT INTO conversa'));
  assert.equal(ins.binds.fst, 'em_atendimento');
  assert.equal(ins.binds.prot, null);
  assert.equal(eventos.some((e) => e.tipo === 'fila'), false);
});

test('FIL-76 (achado de review): conversa NOVA grava um evento conversa_iniciada (não existia produtor)', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConn({ deptoDoNumero: 4, capturas });

  await processPayload(payloadInbound());

  const evt = capturas.find((c) => /INSERT INTO consumo_evento/i.test(c.sql));
  assert.ok(evt, 'não gravou o evento conversa_iniciada');
  assert.equal(evt.binds.tipo, 'conversa_iniciada');
  assert.equal(evt.binds.tenantId, 1);
});

test('FIL-76: renovar conversa EXISTENTE não grava conversa_iniciada de novo', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConn({
    deptoDoNumero: 4,
    conversaExistente: { ID: 50, DEPARTAMENTO_ID: 4 },
    capturas,
  });

  await processPayload(payloadInbound());

  const evt = capturas.find((c) => /INSERT INTO consumo_evento/i.test(c.sql) && c.binds.tipo === 'conversa_iniciada');
  assert.equal(evt, undefined, 'renovar janela de conversa já existente não é uma conversa NOVA');
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

  const upd = capturas.find((c) => c.sql.startsWith('UPDATE conversa'));
  assert.ok(upd, 'deve renovar a conversa existente');
  assert.equal(/fila_status/.test(upd.sql), false);   // não mexe no ciclo do atendimento
  assert.equal(/protocolo/.test(upd.sql), false);     // não gera protocolo novo
  assert.equal(capturas.some((c) => c.sql.startsWith('INSERT INTO conversa')), false);
});

// REGRESSÃO: catch de 23505 deixava a transação Postgres em estado ABORTADO
// (25P02) até o ROLLBACK — a mensagem seguinte do MESMO change (mesma
// transação tenant-scoped) parava de gravar silenciosamente. ON CONFLICT DO
// NOTHING nunca levanta erro no Postgres, então o resto do lote continua.
function fakeConnRedelivery(capturas = []) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM numero')) {
        return { rows: [{ ID: 2, TENANT_ID: 1, DEPARTAMENTO_PADRAO_ID: null, MODO: 'padrao', FLUXO_ID: null }] };
      }
      if (sql.includes('FROM MC_ZAP_CONTATO')) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] };
      if (sql.startsWith('INSERT INTO mensagem')) {
        // Simula o ON CONFLICT DO NOTHING real do Postgres: 0 linhas afetadas
        // pro WAMID que já existe, 1 pro novo — nunca lança.
        return { rowsAffected: binds.wamid === 'wamid.DUP' ? 0 : 1 };
      }
      if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260610100088' }] };
      if (sql.startsWith('INSERT INTO conversa')) return { outBinds: { id: [70] } };
      if (sql.includes('FROM conversa')) return { rows: [] };
      return { rows: [], outBinds: {}, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('redelivery: WAMID duplicado (dedup via ON CONFLICT) não aborta o resto do lote', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConnRedelivery(capturas);

  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '1112223334', display_phone_number: '556237731090' },
      contacts: [{ wa_id: '5562999990000', profile: { name: 'Cliente' } }],
      messages: [
        { id: 'wamid.DUP', from: '5562999990000', timestamp: '1718000000', type: 'text', text: { body: 'reentrega' } },
        { id: 'wamid.NOVO', from: '5562999990000', timestamp: '1718000001', type: 'text', text: { body: 'mensagem seguinte' } },
      ],
    } }] }],
  };

  await assert.doesNotReject(processPayload(payload));

  const insMsgs = capturas.filter((c) => c.sql.startsWith('INSERT INTO mensagem'));
  assert.equal(insMsgs.length, 2, 'as DUAS tentativas de INSERT rodaram — a duplicada não abortou a transação');
  assert.match(insMsgs[0].sql, /ON CONFLICT\s*\(tenant_id,\s*wamid\)\s*DO NOTHING/i);

  // A mensagem seguinte (não duplicada) foi processada até o fim, prova de que
  // a transação continuou viva depois do "conflito" da primeira.
  const insConversas = capturas.filter((c) => c.sql.startsWith('INSERT INTO conversa'));
  assert.equal(insConversas.length, 2, 'as duas mensagens do lote devem ter sido processadas');
});

// ─── Dispatch webhook → bot/runtime.js ─────────────────────────────────────
// processEvent.js decide SE/COMO aciona o bot e com quais argumentos — o motor
// do bot (engine + runtime.js real) já tem cobertura própria em
// test/bot-webhook.test.js (FIL-62). Aqui mocka-se runtime.iniciarFluxo/
// processarEntrada como espiões pra provar que a borda do webhook (FIL-60)
// passa o tenantId certo e respeita o opt-out antes de acionar o bot.
function payloadFluxo(texto) {
  return {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '1112223334', display_phone_number: '556237731090' },
      contacts: [{ wa_id: '5562999990000', profile: { name: 'Cliente' } }],
      messages: [{ id: 'wamid.' + Math.random(), from: '5562999990000', timestamp: '1718000000', type: 'text', text: { body: texto } }],
    } }] }],
  };
}

function fakeConnBot({ conversaExistente = null, capturas = [] } = {}) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM numero')) {
        return { rows: [{ ID: 2, TENANT_ID: 1, DEPARTAMENTO_PADRAO_ID: null, MODO: 'padrao', FLUXO_ID: 9 }] };
      }
      if (sql.includes('FROM MC_ZAP_CONTATO')) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] };
      if (sql.includes('FROM conversa')) return { rows: conversaExistente ? [conversaExistente] : [] };
      if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260610100077' }] };
      if (sql.startsWith('INSERT INTO conversa')) return { outBinds: { id: [88] } };
      return { rows: [], outBinds: { id: [1] }, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('dispatch: conversa NOVA em número com fluxo → runtime.iniciarFluxo(tenantId, conversaId)', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConnBot({ capturas });
  let chamado = null;
  const original = runtime.iniciarFluxo;
  runtime.iniciarFluxo = (tenantId, conversaId) => { chamado = { tenantId, conversaId }; };
  try {
    await processPayload(payloadFluxo('oi'));
    assert.deepEqual(chamado, { tenantId: 1, conversaId: 88 });
    const ins = capturas.find((c) => c.sql.startsWith('INSERT INTO conversa'));
    assert.equal(ins.binds.fst, 'bot');
    assert.equal(ins.binds.flx, 9);
  } finally {
    runtime.iniciarFluxo = original;
  }
});

test('dispatch: resposta de texto em conversa JÁ em bot → runtime.processarEntrada(tenantId, conversaId, texto)', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConnBot({
    capturas,
    conversaExistente: { ID: 88, DEPARTAMENTO_ID: null, FILA_STATUS: 'bot' },
  });
  let chamado = null;
  const original = runtime.processarEntrada;
  runtime.processarEntrada = (tenantId, conversaId, texto) => { chamado = { tenantId, conversaId, texto }; };
  try {
    await processPayload(payloadFluxo('1'));
    assert.deepEqual(chamado, { tenantId: 1, conversaId: 88, texto: '1' });
  } finally {
    runtime.processarEntrada = original;
  }
});

test('dispatch: "PARAR" em conversa bot registra opt-out, ENCERRA e NÃO aciona o bot', async () => {
  presence._reset();
  const capturas = [];
  db.getConnection = async () => fakeConnBot({
    capturas,
    conversaExistente: { ID: 88, DEPARTAMENTO_ID: null, FILA_STATUS: 'bot' },
  });
  let chamouRuntime = false;
  const originalIniciar = runtime.iniciarFluxo;
  const originalEntrada = runtime.processarEntrada;
  runtime.iniciarFluxo = () => { chamouRuntime = true; };
  runtime.processarEntrada = () => { chamouRuntime = true; };
  try {
    await processPayload(payloadFluxo('PARAR'));
    assert.equal(chamouRuntime, false, 'bot não pode ser acionado após opt-out');
    assert.ok(capturas.some((c) => c.sql.includes(`optin = 'N'`)), 'deve registrar opt-out');
    const upd = capturas.find((c) => c.sql.includes(`fila_status = 'resolvida'`) && c.sql.startsWith('UPDATE'));
    assert.ok(upd, 'deve encerrar a conversa do bot');
  } finally {
    runtime.iniciarFluxo = originalIniciar;
    runtime.processarEntrada = originalEntrada;
  }
});
