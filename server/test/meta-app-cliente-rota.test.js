// FIL-97 — rotas do app da Meta do cliente (GET/PUT /api/meta/app).
//
// Três coisas que não podem regredir:
//   1. é tarefa do OPERADOR em sessão de suporte auditada — um ADMIN do cliente
//      não configura credencial de app (mesmo gate do /signup/exchange);
//   2. o App Secret é gravado CIFRADO e nunca volta em resposta nenhuma;
//   3. a escrita deixa trilha na `auditoria` que o próprio cliente lê — com o
//      QUE mudou, nunca com o valor.
'use strict';

process.env.META_APP_SECRET = 'segredo-global-da-plataforma';
process.env.META_APP_ID = 'app-da-plataforma';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.JWT_SECRET = 'master-secret-de-teste-com-tamanho-suficiente';
process.env.IA_CRYPTO_KEY = 'chave-de-teste-dedicada-com-tamanho-ok-32+';
process.env.WEBHOOK_BASE_URL = 'https://api.olume.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const db = require('../db/pool');
const appCliente = require('../meta/appCliente');
const { descriptografar } = require('../ia/crypto');
const { router } = require('../api/meta');

const T = 42;
const SEGREDO = 'chave-secreta-do-app-do-cliente';
const TOKEN = 'EAAB-token-permanente-do-cliente';

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const req = http.request({
        hostname: '127.0.0.1', port: s.address().port, path, method,
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { s.close(); resolve({ status: res.statusCode, body: data }); });
      });
      req.on('error', (e) => { s.close(); reject(e); });
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  });
}

/** App com o req.user que o auth/middleware.js montaria. */
function montar({ suporte }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = T; req.user = { suporte, email: 'op@olume.test', papel: 'ADMIN' }; next(); });
  app.use('/meta', router);
  return app;
}

/** Estado mínimo de `meta_conexao` + captura das escritas. */
function fakeComTenant(linha) {
  const capturado = { updates: [], auditorias: [] };
  db.comTenant = async (_tenantId, fn) => fn({
    async execute(sql, binds) {
      if (/FROM meta_conexao/i.test(sql)) return { rows: linha ? [linha] : [] };
      if (/INSERT INTO meta_conexao/i.test(sql)) {
        linha = linha || {};
        linha.ACCESS_TOKEN_CRIPTOGRAFADO = binds.token;
        linha.TEM_TOKEN = true;
        capturado.updates.push(binds);
        return { rows: [], rowsAffected: 1 };
      }
      if (/UPDATE meta_conexao/i.test(sql)) {
        capturado.updates.push(binds);
        if (binds.appId) linha.APP_ID = binds.appId;
        if (binds.segredo) { linha.APP_SECRET_CRIPTOGRAFADO = binds.segredo; linha.TEM_APP_SECRET = true; }
        linha.WEBHOOK_IDENTIFICADOR = linha.WEBHOOK_IDENTIFICADOR || binds.ident;
        return { rows: [], rowsAffected: 1 };
      }
      if (/INSERT INTO auditoria/i.test(sql)) { capturado.auditorias.push(binds); return { rows: [], rowsAffected: 1 }; }
      return { rows: [], rowsAffected: 0 };
    },
  });
  return capturado;
}

test('GET/PUT /meta/app: ADMIN comum do cliente não configura credencial de app', async () => {
  const app = montar({ suporte: false });
  const get = await request(app, 'GET', '/meta/app');
  assert.equal(get.status, 403);
  const put = await request(app, 'PUT', '/meta/app', { appId: 'x', appSecret: 'y' });
  assert.equal(put.status, 403);
});

test('PUT /meta/app: grava cifrado, gera o caminho e devolve a URL — sem o segredo', async () => {
  const old = db.comTenant;
  const cap = fakeComTenant({
    TENANT_ID: T, APP_ID: null, WEBHOOK_IDENTIFICADOR: null,
    TEM_APP_SECRET: false, TEM_TOKEN: false, STATUS: 'conectando', ATUALIZADO_EM: null,
  });
  try {
    const r = await request(montar({ suporte: true }), 'PUT', '/meta/app', {
      appId: '1234567890', appSecret: SEGREDO, accessToken: TOKEN,
    });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);

    // A URL sai pronta para colar no app da Meta do cliente.
    assert.match(body.webhookUrl, /^https:\/\/api\.olume\.test\/webhook\/[0-9a-f]{32}$/);
    assert.equal(body.temAppSecret, true);
    assert.equal(body.temToken, true);

    // Nem o segredo nem o token aparecem na resposta.
    assert.ok(!r.body.includes(SEGREDO));
    assert.ok(!r.body.includes(TOKEN));

    // E no banco entraram cifrados, cada um no seu contexto.
    const update = cap.updates.find((u) => u.segredo);
    assert.ok(update, 'App Secret não foi gravado');
    assert.notEqual(update.segredo, SEGREDO);
    assert.equal(descriptografar(update.segredo, T, undefined, appCliente.CONTEXTO), SEGREDO);
    assert.throws(() => descriptografar(update.segredo, T, undefined, 'meta_access_token'),
      'o blob do App Secret não pode abrir no contexto do access token');

    // Trilha que o cliente lê: o que mudou, nunca o valor.
    assert.equal(cap.auditorias.length, 1);
    const detalhe = JSON.parse(cap.auditorias[0].det);
    assert.deepEqual(detalhe, { appId: '1234567890', appSecret: true, accessToken: true, operador: 'op@olume.test' });
    assert.ok(!cap.auditorias[0].det.includes(SEGREDO));
  } finally { db.comTenant = old; }
});

test('PUT /meta/app: sem token permanente gravado, recusa com 409 explicativo', async () => {
  const old = db.comTenant;
  fakeComTenant({ TENANT_ID: T, TEM_APP_SECRET: false, TEM_TOKEN: false, WEBHOOK_IDENTIFICADOR: null });
  try {
    const r = await request(montar({ suporte: true }), 'PUT', '/meta/app', { appId: 'só-o-app-id' });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.body).error, /token permanente/i);
  } finally { db.comTenant = old; }
});

test('PUT /meta/app: campo vazio MANTÉM o valor gravado (a tela nunca devolve o segredo)', async () => {
  const old = db.comTenant;
  const cap = fakeComTenant({
    TENANT_ID: T, APP_ID: 'antigo', WEBHOOK_IDENTIFICADOR: 'f'.repeat(32),
    TEM_APP_SECRET: true, TEM_TOKEN: true,
  });
  try {
    const r = await request(montar({ suporte: true }), 'PUT', '/meta/app', { appId: 'novo', appSecret: '' });
    assert.equal(r.status, 200);
    const update = cap.updates[cap.updates.length - 1];
    assert.equal(update.appId, 'novo');
    assert.equal(update.segredo, null, 'segredo vazio não pode apagar o que já existe');
    // O caminho já publicado no app do cliente NUNCA é rotacionado por uma edição.
    assert.equal(JSON.parse(r.body).webhookUrl, `https://api.olume.test/webhook/${'f'.repeat(32)}`);
  } finally { db.comTenant = old; }
});

test('PUT /meta/app: requisição sem nenhum campo é 400 (não gera caminho à toa)', async () => {
  const old = db.comTenant;
  const cap = fakeComTenant({ TENANT_ID: T, TEM_TOKEN: true, WEBHOOK_IDENTIFICADOR: null });
  try {
    const r = await request(montar({ suporte: true }), 'PUT', '/meta/app', {});
    assert.equal(r.status, 400);
    assert.equal(cap.updates.length, 0);
  } finally { db.comTenant = old; }
});
