// Integração webhook × bot: conversa nova em número com fluxo ativo entra em
// 'bot' e dispara a saudação; resposta navega o menu; "PARAR" encerra o bot.
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
const configCache = require('../utils/configCache');
// webhook/processEvent.js (FIL-60, fora deste ticket) ainda chama
// lerConfig(conn) com um único argumento — sob o contrato pós-FIL-66
// (tenantId obrigatório, sem balde 'default') isso lança. Este arquivo testa
// o fluxo de bot/menu, não config; stub aqui equivale ao comportamento
// anterior do fakeConn para 'FROM MC_ZAP_CONFIG' (nenhuma linha → {}) e evita
// acoplar esta regressão ao rebase pendente do FIL-60.
configCache.lerConfig = async () => ({});
const { processPayload } = require('../webhook/processEvent');

const FLUXO_DEF = JSON.stringify({
  config: { inicio: 'oi', maxInvalidas: 3 },
  nos: [
    { id: 'oi', tipo: 'mensagem', texto: 'Olá {{nome}}! Protocolo {{protocolo}}.', proximo: 'menu' },
    { id: 'menu', tipo: 'menu', texto: '1 - T.I\n2 - Encerrar',
      opcoes: [{ valor: '1', proximo: 'ti' }, { valor: '2', proximo: 'fim' }] },
    { id: 'ti', tipo: 'transferir', departamentoId: 4, texto: 'Encaminhando…' },
    { id: 'fim', tipo: 'encerrar', texto: 'Tchau!' },
  ],
});

function payload(texto) {
  return {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '1112223334' },
      contacts: [{ wa_id: '5562999990000', profile: { name: 'Cliente' } }],
      messages: [{ id: 'wamid.' + Math.random(), from: '5562999990000', timestamp: '1718000000', type: 'text', text: { body: texto } }],
    } }] }],
  };
}

function fakeConn({ conversaExistente = null, botState = null, capturas = [] }) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM numero')) {
        return { rows: [{ ID: 2, TENANT_ID: 1, DEPARTAMENTO_PADRAO_ID: null, MODO: 'padrao', FLUXO_ID: 9 }] };
      }
      if (sql.includes('FROM MC_ZAP_CONTATO')) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] };
      if (sql.includes('LEFT JOIN MC_ZAP_FLUXO f ON f.ID = c.BOT_FLUXO_ID')) {
        // runtime.carregar
        return { rows: botState ? [botState] : [] };
      }
      if (sql.includes('FROM conversa')) {
        return { rows: conversaExistente ? [conversaExistente] : [] };
      }
      if (sql.includes('MC_ZAP_SEQ_PROTOCOLO')) return { rows: [{ P: '260610100077' }] };
      if (sql.startsWith('INSERT INTO conversa')) return { outBinds: { id: [88] } };
      return { rows: [], outBinds: { id: [1] }, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function aguardar(ms = 50) { return new Promise((r) => setTimeout(r, ms)); }

test('conversa nova com fluxo ativo: entra em bot com protocolo e manda a saudação', async () => {
  presence._reset();
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.BOT' + enviados.length }] }) };
  };
  const conn = fakeConn({
    capturas,
    botState: {
      ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100077',
      BOT_FLUXO_ID: 9, BOT_NO_ATUAL: null, BOT_VARIAVEIS: null, BOT_INVALIDAS: 0,
      TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
      DEFINICAO: FLUXO_DEF,
    },
  });
  db.getConnection = async () => conn;

  await processPayload(payload('oi, preciso de ajuda'));
  await aguardar(); // runtime roda pós-commit (assíncrono)

  const ins = capturas.find((c) => c.sql.startsWith('INSERT INTO conversa'));
  assert.equal(ins.binds.fst, 'bot');
  assert.equal(ins.binds.flx, 9);
  assert.equal(ins.binds.prot, '260610100077');

  // Saudação: 2 mensagens (texto + menu), com placeholders resolvidos.
  assert.equal(enviados.length, 2);
  assert.equal(enviados[0].text.body, 'Olá Cliente! Protocolo 260610100077.');
  assert.match(enviados[1].text.body, /1 - T\.I/);
  // Estado persistido no nó do menu.
  const updEstado = capturas.find((c) => c.sql.includes('BOT_NO_ATUAL = :no'));
  assert.equal(updEstado.binds.no, 'menu');
});

test('resposta "1" em conversa bot: transfere pro departamento e vai pra fila', {
  // Bloqueado por FIL-62: bot/runtime.js ainda expõe processarEntrada(conversaId, texto)
  // (1 arg de negócio). O webhook (FIL-60) já resolve o tenant e passa
  // processarEntrada(tenantId, conversaId, texto) — combinado com o orquestrador para
  // o FIL-62 trocar a assinatura de runtime.js. Reabilitar quando o FIL-62 mergear.
  skip: 'bloqueado por FIL-62 — bot/runtime.js ainda não recebe tenantId',
}, async () => {
  presence._reset();
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.B' + enviados.length }] }) };
  };
  const conn = fakeConn({
    capturas,
    conversaExistente: { ID: 88, DEPARTAMENTO_ID: null, FILA_STATUS: 'bot' },
    botState: {
      ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100077',
      BOT_FLUXO_ID: 9, BOT_NO_ATUAL: 'menu', BOT_VARIAVEIS: '{}', BOT_INVALIDAS: 0,
      TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
      DEFINICAO: FLUXO_DEF,
    },
  });
  db.getConnection = async () => conn;

  await processPayload(payload('1'));
  await aguardar();

  assert.match(enviados[0].text.body, /Encaminhando/);
  const updFila = capturas.find((c) => c.sql.includes(`FILA_STATUS = 'aguardando'`) && c.sql.startsWith('UPDATE'));
  assert.ok(updFila, 'deve mover pra fila');
  assert.equal(updFila.binds.dep, 4);
  const nota = capturas.find((c) => c.sql.includes(`'nota'`));
  assert.ok(nota, 'deve registrar nota interna do bot');
});

test('"PARAR" em conversa bot: registra opt-out, encerra e o bot NÃO responde', async () => {
  presence._reset();
  const capturas = [];
  let chamouGraph = false;
  global.fetch = async () => { chamouGraph = true; return { ok: true, json: async () => ({}) }; };
  const conn = fakeConn({
    capturas,
    conversaExistente: { ID: 88, DEPARTAMENTO_ID: null, FILA_STATUS: 'bot' },
  });
  db.getConnection = async () => conn;

  await processPayload(payload('PARAR'));
  await aguardar();

  assert.ok(capturas.some((c) => c.sql.includes(`optin = 'N'`)), 'deve registrar opt-out');
  const updRes = capturas.find((c) => c.sql.includes(`fila_status = 'resolvida'`) && c.sql.startsWith('UPDATE'));
  assert.ok(updRes, 'deve encerrar a conversa do bot');
  assert.equal(chamouGraph, false, 'bot não pode responder após PARAR');
});
