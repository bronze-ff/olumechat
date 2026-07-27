// Integração bot/runtime.js × bot/engine.js: conversa já em 'bot' recebe a
// saudação; resposta navega o menu; comTenant() sempre abre com o tenantId
// recebido do chamador.
//
// ANTES este arquivo também testava webhook/processEvent.js (criação da
// conversa, opt-out por "PARAR") em conjunto com o runtime. Esse módulo é do
// FIL-60 (fora do escopo do FIL-62) e ainda não foi portado para Postgres —
// runtime.js agora exige tenantId como 1º parâmetro (iniciarFluxo,
// processarEntrada, expirar), contrato que só a borda do webhook, já portada,
// vai poder cumprir. Esses testes passam a exercitar só runtime+engine,
// diretamente; a integração completa com o webhook fica pro FIL-60.
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
const runtime = require('../bot/runtime');

const TENANT_ID = 1;

const FLUXO_DEF = {
  config: { inicio: 'oi', maxInvalidas: 3 },
  nos: [
    { id: 'oi', tipo: 'mensagem', texto: 'Olá {{nome}}! Protocolo {{protocolo}}.', proximo: 'menu' },
    { id: 'menu', tipo: 'menu', texto: '1 - T.I\n2 - Encerrar',
      opcoes: [{ valor: '1', proximo: 'ti' }, { valor: '2', proximo: 'fim' }] },
    { id: 'ti', tipo: 'transferir', departamentoId: 4, texto: 'Encaminhando…' },
    { id: 'fim', tipo: 'encerrar', texto: 'Tchau!' },
  ],
};

/** Fake conn no nível "já wrapped" — o mesmo formato que db.getConnection()
    devolve de verdade (chaves MAIÚSCULAS, jsonb já parseado). comTenant()
    chama execute() para SET LOCAL ROLE/set_config antes da lógica de negócio;
    o default { rows: [] } cobre essas duas chamadas sem precisar de match. */
function fakeConn(handler) {
  return {
    async execute(sql, binds) { return handler(sql, binds) || { rows: [] }; },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function aguardar(ms = 50) { return new Promise((r) => setTimeout(r, ms)); }

test('iniciarFluxo: conversa em bot recebe a saudação e o menu', async () => {
  presence._reset();
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.BOT' + enviados.length }] }) };
  };
  const conn = fakeConn((sql, binds) => {
    capturas.push({ sql, binds });
    if (sql.includes('FROM conversa')) {
      return {
        rows: [{
          ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100077',
          BOT_FLUXO_ID: 9, BOT_NO_ATUAL: null, BOT_VARIAVEIS: null, BOT_INVALIDAS: 0,
          TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
          DEFINICAO: FLUXO_DEF,
        }],
      };
    }
  });
  db.getConnection = async () => conn;

  await runtime.iniciarFluxo(TENANT_ID, 88);
  await aguardar();

  const carregou = capturas.find((c) => c.sql.includes('FROM conversa'));
  assert.equal(carregou.binds.tid, TENANT_ID);

  assert.equal(enviados.length, 2);
  assert.equal(enviados[0].text.body, 'Olá Cliente! Protocolo 260610100077.');
  assert.match(enviados[1].text.body, /1 - T\.I/);
  const updEstado = capturas.find((c) => c.sql.includes('bot_no_atual = :no'));
  assert.equal(updEstado.binds.no, 'menu');
});

test('processarEntrada: "1" em conversa bot transfere pro departamento e vai pra fila', async () => {
  presence._reset();
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.B' + enviados.length }] }) };
  };
  const conn = fakeConn((sql, binds) => {
    capturas.push({ sql, binds });
    if (sql.includes('FROM conversa')) {
      return {
        rows: [{
          ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100077',
          BOT_FLUXO_ID: 9, BOT_NO_ATUAL: 'menu', BOT_VARIAVEIS: {}, BOT_INVALIDAS: 0,
          TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
          DEFINICAO: FLUXO_DEF,
        }],
      };
    }
  });
  db.getConnection = async () => conn;

  await runtime.processarEntrada(TENANT_ID, 88, '1');
  await aguardar();

  assert.match(enviados[0].text.body, /Encaminhando/);
  const updFila = capturas.find((c) => c.sql.includes(`fila_status = 'aguardando'`) && c.sql.startsWith('UPDATE'));
  assert.ok(updFila, 'deve mover pra fila');
  assert.equal(updFila.binds.dep, 4);
  assert.equal(updFila.binds.tid, TENANT_ID);
  const nota = capturas.find((c) => c.sql.includes(`'nota'`));
  assert.ok(nota, 'deve registrar nota interna do bot');
});

test('iniciarFluxo: tenantId inválido não chega a abrir conexão nem a enviar nada', async () => {
  let chamouFetch = false;
  let getConnectionChamado = false;
  global.fetch = async () => { chamouFetch = true; return { ok: true, json: async () => ({}) }; };
  db.getConnection = async () => {
    getConnectionChamado = true;
    throw new Error('não deveria abrir conexão sem tenantId válido');
  };

  await runtime.iniciarFluxo(0, 88); // tenantId inválido: comTenant recusa antes de tocar o banco
  await aguardar();

  assert.equal(getConnectionChamado, false, 'comTenant deve validar tenantId antes de abrir a conexão');
  assert.equal(chamouFetch, false);
});
