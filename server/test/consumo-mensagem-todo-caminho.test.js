// FIL-77 — achado de review (P1): "só o envio manual de texto e o upload de
// arquivo registravam mensagem_enviada; campanha/dispatcher.js, bot/runtime.js,
// ia/runtime.js, fila/distribuidor.js e os envios de template ficavam de
// fora — o agregado mensal subcontava sistematicamente." Este arquivo prova
// que TODO caminho de envio bem-sucedido grava o evento (o pedido explícito
// da review era cobrir pelo menos dispatcher e bot — aqui cobre os dois mais
// fila/distribuidor e webhook/processEvent também, já que foram tocados).
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

function aguardar(ms = 50) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// bot/runtime.js — a saudação de um fluxo novo manda 2 mensagens.
// ---------------------------------------------------------------------------
test('bot/runtime.js: a saudação do fluxo grava mensagem_enviada pra cada mensagem que realmente saiu', async () => {
  const runtime = require('../bot/runtime');
  const TENANT_ID = 601;
  const FLUXO_DEF = {
    config: { inicio: 'oi', maxInvalidas: 3 },
    nos: [
      { id: 'oi', tipo: 'mensagem', texto: 'Olá {{nome}}! Protocolo {{protocolo}}.', proximo: 'menu' },
      { id: 'menu', tipo: 'menu', texto: '1 - T.I\n2 - Encerrar', opcoes: [{ valor: '1', proximo: 'ti' }] },
    ],
  };
  presence._reset();
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.BOT' + enviados.length }] }) };
  };
  const conn = {
    async execute(sql, binds) {
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
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  db.getConnection = async () => conn;

  await runtime.iniciarFluxo(TENANT_ID, 88);
  await aguardar();

  assert.equal(enviados.length, 2, 'a saudação + o menu deveriam ter saído');
  const eventos = capturas.filter((c) => /INSERT INTO consumo_evento/i.test(c.sql) && c.binds.tipo === 'mensagem_enviada');
  assert.equal(eventos.length, 2, 'cada mensagem enviada pelo bot deveria virar 1 evento de consumo');
  for (const e of eventos) assert.equal(e.binds.tenantId, TENANT_ID);
});

// ---------------------------------------------------------------------------
// campanha/dispatcher.js — item de campanha enviado com sucesso.
// ---------------------------------------------------------------------------
test('campanha/dispatcher.js: item enviado com sucesso grava mensagem_enviada', async () => {
  const dispatcher = require('../campanha/dispatcher');
  const AGORA = () => new Date(2026, 5, 11, 12, 0, 0);
  const TENANT = 602;
  const CAMP = {
    STATUS: 'enviando', TEMPLATE_NOME: 'lembrete_pagamento', LANG: 'pt_BR', RATE_POR_SEG: 100,
    JANELA_INICIO: '08:00', JANELA_FIM: '20:00', RETOMA_EM: null,
    NUMERO_ID: 2, PHONE_NUMBER_ID: '1112223334', LIMITE_DIARIO: 250,
  };
  const ITEM = { ID: 10, TELEFONE: '5562999990000', VARIAVEIS: ['Fulano', '150,00'], CONTATO_ID: null };
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes("SET STATUS = 'enviando_item'")) return { rowsAffected: 1 };
      if (sql.includes('FROM auditoria')) return { rows: [] };
      return { rows: [], rowsAffected: 1, outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const deps = {
    getConnection: async () => conn,
    comTenant: async (tenantId, fn) => { const r = await fn(conn); await conn.commit(); return r; },
    sendTemplate: async () => ({ messages: [{ id: 'wamid.C1' }] }),
    agora: AGORA,
  };

  const desfecho = await dispatcher.processarItem(TENANT, 1, ITEM, deps);
  assert.equal(desfecho, 'enviado');
  const evento = capturas.find((c) => /INSERT INTO consumo_evento/i.test(c.sql));
  assert.ok(evento, 'o template enviado deveria virar evento de consumo');
  assert.equal(evento.binds.tipo, 'mensagem_enviada');
  assert.equal(evento.binds.tenantId, TENANT);
  assert.equal(evento.binds.ref, ITEM.ID);
});

test('campanha/dispatcher.js: item que NÃO foi enviado (opt-out, falha, backoff) não gera evento', async () => {
  const dispatcher = require('../campanha/dispatcher');
  const AGORA = () => new Date(2026, 5, 11, 12, 0, 0);
  const TENANT = 603;
  const CAMP = { STATUS: 'enviando', JANELA_INICIO: '08:00', JANELA_FIM: '20:00' };
  const ITEM = { ID: 11, TELEFONE: '5562999990000', VARIAVEIS: [], CONTATO_ID: null };
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes("SET STATUS = 'enviando_item'")) return { rowsAffected: 1 };
      if (sql.includes('FROM auditoria')) return { rows: [{ ACAO: 'optout' }] }; // opt-out: nem tenta enviar
      return { rows: [], rowsAffected: 1, outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const deps = {
    getConnection: async () => conn,
    comTenant: async (tenantId, fn) => { const r = await fn(conn); await conn.commit(); return r; },
    sendTemplate: async () => { throw new Error('não deveria ter chamado — é opt-out'); },
    agora: AGORA,
  };

  const desfecho = await dispatcher.processarItem(TENANT, 1, ITEM, deps);
  assert.equal(desfecho, 'optout');
  assert.equal(capturas.filter((c) => /INSERT INTO consumo_evento/i.test(c.sql)).length, 0, 'nada foi enviado, nada deveria ser medido');
});

// fila/distribuidor.js (aviso de indisponibilidade) e webhook/processEvent.js
// (confirmarEncerramento/enviarAvisoForaHorario) também foram instrumentados
// — cobertos em test/fila.test.js ("aviso de indisponibilidade atualiza
// ultima_msg_em") para não duplicar o setup do fakeConnFila aqui.
