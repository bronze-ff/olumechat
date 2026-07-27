// Testes do webhook e da camada Graph — rodam SEM banco e SEM Meta reais.
// Usa o test runner nativo (node --test). Env dummy setado ANTES dos requires,
// porque config/client validam env no carregamento do módulo.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.GRAPH_VERSION = 'v21.0';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const { isValidSignature } = require('../webhook/verifySignature');
const { buildWebhookRouter } = require('../webhook/routes');

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// --- helpers HTTP simples sobre node:http ---
function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function startServer() {
  const app = express();
  const cfg = { verifyToken: 'verify123', appSecret: 'test_app_secret' };
  app.use('/', buildWebhookRouter(cfg));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

// ===================== verifySignature (puro) =====================
test('isValidSignature: assinatura correta valida', () => {
  const body = Buffer.from(JSON.stringify({ a: 1 }));
  assert.equal(isValidSignature(body, sign(body, 'test_app_secret'), 'test_app_secret'), true);
});

test('isValidSignature: assinatura incorreta rejeita', () => {
  const body = Buffer.from(JSON.stringify({ a: 1 }));
  assert.equal(isValidSignature(body, sign(body, 'errado'), 'test_app_secret'), false);
});

test('isValidSignature: header ausente ou prefixo errado rejeita', () => {
  const body = Buffer.from('x');
  assert.equal(isValidSignature(body, undefined, 's'), false);
  assert.equal(isValidSignature(body, 'abc', 's'), false);
});

// ===================== webhook GET (verificação) =====================
test('GET /webhook: token correto retorna o challenge (200)', async () => {
  const { server, port } = await startServer();
  try {
    const r = await request('GET',
      `http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=verify123&hub.challenge=DESAFIO`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'DESAFIO');
  } finally { server.close(); }
});

test('GET /webhook: token errado retorna 403', async () => {
  const { server, port } = await startServer();
  try {
    const r = await request('GET',
      `http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=ERRADO&hub.challenge=X`);
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

// ===================== webhook POST (assinatura) =====================
test('POST /webhook: assinatura inválida retorna 401', async () => {
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const r = await request('POST', `http://127.0.0.1:${port}/webhook`, {
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      body,
    });
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

test('POST /webhook: assinatura válida retorna 200 (sem entry para processar)', async () => {
  const { server, port } = await startServer();
  try {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const r = await request('POST', `http://127.0.0.1:${port}/webhook`, {
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body, 'test_app_secret'),
      },
      body,
    });
    assert.equal(r.status, 200);
  } finally { server.close(); }
});

// ===================== Graph: corpo dos envios =====================
test('sendText monta o corpo correto', async () => {
  let captured;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
  };
  const { sendText } = require('../graph/sendText');
  const r = await sendText('5562999990000', 'Olá');
  assert.equal(r.messages[0].id, 'wamid.X');
  assert.match(captured.url, /\/1112223334\/messages$/); // usa o phone number id do .env
  assert.equal(captured.body.type, 'text');
  assert.equal(captured.body.to, '5562999990000');
  assert.equal(captured.body.text.body, 'Olá');
});

test('sendTemplate monta componentes com as variáveis na ordem', async () => {
  let captured;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.Y' }] }) };
  };
  const { sendTemplate } = require('../graph/sendTemplate');
  await sendTemplate('5562999990000', 'lembrete_pagamento', 'pt_BR', ['Fulano', '123', '1.500,00']);
  assert.equal(captured.body.type, 'template');
  assert.equal(captured.body.template.name, 'lembrete_pagamento');
  assert.equal(captured.body.template.language.code, 'pt_BR');
  const params = captured.body.template.components[0].parameters;
  assert.deepEqual(params.map((p) => p.text), ['Fulano', '123', '1.500,00']);
});

// usa um phone number id custom (multi-número)
test('sendText aceita phoneNumberId custom (multi-número)', async () => {
  let captured;
  global.fetch = async (url, opts) => {
    captured = { url };
    return { ok: true, json: async () => ({ messages: [{ id: 'z' }] }) };
  };
  const { sendText } = require('../graph/sendText');
  await sendText('5562999990000', 'oi', '5550009999');
  assert.match(captured.url, /\/5550009999\/messages$/);
});
