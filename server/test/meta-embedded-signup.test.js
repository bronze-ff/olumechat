'use strict';

process.env.META_APP_SECRET = 'app-secret-test';
process.env.META_APP_ID = 'app-id-test';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify-test';
process.env.JWT_SECRET = 'master-secret-test-which-is-long-enough';
process.env.DEV_META_FALLBACK = '0';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');
const { criptografar, descriptografar } = require('../ia/crypto');
const { guardar, resolver, CONTEXTO } = require('../meta/connection');
const { storage } = require('../storage');

const A = 101;
const B = 202;
const TOKEN_A = 'EAAB-token-do-tenant-A-super-secreto';
const TOKEN_B = 'EAAB-token-do-tenant-B-super-secreto';

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path, method,
        headers: { 'content-type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { s.close(); resolve({ status: res.statusCode, body: data }); });
      });
      req.on('error', (e) => { s.close(); reject(e); });
      req.end(JSON.stringify(body));
    });
  });
}

test('Meta: token persistido é cifrado e nunca aparece em resposta ou log', async () => {
  let bind;
  const conn = {
    async execute(_sql, b) { bind = b; return { rows: [], rowsAffected: 1 }; },
  };
  const originalComTenant = db.comTenant;
  db.comTenant = async (_tenantId, fn) => fn(conn);
  try {
    const logs = [];
    const oldLog = console.log;
    const oldWarn = console.warn;
    const oldError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));
    try { await guardar({ tenantId: A, accessToken: TOKEN_A, wabaId: 'waba-a' }); }
    finally { console.log = oldLog; console.warn = oldWarn; console.error = oldError; }

    assert.ok(bind.token);
    assert.notEqual(bind.token, TOKEN_A);
    assert.equal(descriptografar(bind.token, A, undefined, CONTEXTO), TOKEN_A);
    assert.ok(!JSON.stringify(bind).includes(TOKEN_A));
    assert.ok(!logs.join('\n').includes(TOKEN_A));

    const { router } = require('../api/meta');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.tenantId = A; next(); });
    app.use('/meta', router);
    const oldFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ access_token: TOKEN_A }) });
    // A resposta de troca é verificada sem permitir uma gravação real.
    const result = await request(app, 'POST', '/meta/signup/exchange', { code: 'code', phoneNumberId: 'PN-A' });
    global.fetch = oldFetch;
    assert.equal(result.status, 201);
    assert.ok(!result.body.includes(TOKEN_A));
  } finally { db.comTenant = originalComTenant; }
});

test('Meta: tenant A não lê token nem phone_number_id do tenant B', async () => {
  const rows = [
    { TENANT_ID: A, PHONE_NUMBER_ID: 'PN-A', WABA_ID: 'WA-A', ACCESS_TOKEN_CRIPTOGRAFADO: criptografar(TOKEN_A, A, undefined, CONTEXTO) },
    { TENANT_ID: B, PHONE_NUMBER_ID: 'PN-B', WABA_ID: 'WA-B', ACCESS_TOKEN_CRIPTOGRAFADO: criptografar(TOKEN_B, B, undefined, CONTEXTO) },
  ];
  const oldGetConnection = db.getConnection;
  db.getConnection = async () => ({
    async execute(_sql, binds) {
      const row = rows.find((x) => x.PHONE_NUMBER_ID === binds.phone && String(x.TENANT_ID) === String(binds.tenantId));
      return { rows: row ? [row] : [] };
    },
    async close() {},
  });
  try {
    assert.equal(await resolver('PN-B', A), null);
    assert.equal(await resolver('PN-A', B), null);
    const own = await resolver('PN-B', B);
    assert.equal(own.accessToken, TOKEN_B);
    assert.equal(own.phoneNumberId, 'PN-B');
  } finally { db.getConnection = oldGetConnection; }
});

test('Meta: webhook desconhecido não cria tenant, número ou conversa', async () => {
  const banco = { tenant: [], numero: [], conversa: [] };
  const oldGetConnection = db.getConnection;
  db.getConnection = async () => ({
    async execute(sql, binds) {
      if (/FROM\s+numero/i.test(sql)) return { rows: [] };
      if (/INSERT\s+INTO\s+(tenant|numero|conversa)/i.test(sql)) banco.numero.push(binds);
      return { rows: [] };
    },
    async close() {},
  });
  try {
    const { processPayload } = require('../webhook/processEvent');
    await processPayload({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN-UNKNOWN' }, messages: [{ id: 'w1' }] } }] }] });
    assert.deepEqual(banco.tenant, []);
    assert.deepEqual(banco.numero, []);
    assert.deepEqual(banco.conversa, []);
  } finally { db.getConnection = oldGetConnection; }
});

test('Meta: envio usa token do tenant dono, nunca o token global', async () => {
  process.env.DEV_META_FALLBACK = '0';
  const oldGetConnection = db.getConnection;
  db.getConnection = async () => ({
    async execute(_sql, binds) {
      assert.equal(binds.phone, 'PN-A');
      assert.equal(binds.tenantId, A);
      return { rows: [{ TENANT_ID: A, PHONE_NUMBER_ID: 'PN-A', WABA_ID: 'WA-A', ACCESS_TOKEN_CRIPTOGRAFADO: criptografar(TOKEN_A, A, undefined, CONTEXTO) }] };
    },
    async close() {},
  });
  const oldFetch = global.fetch;
  let authorization;
  global.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid-1' }] }) };
  };
  try {
    delete require.cache[require.resolve('../graph/client')];
    delete require.cache[require.resolve('../graph/sendText')];
    const { sendText } = require('../graph/sendText');
    await sendText('5511999999999', 'olá', 'PN-A', A);
    assert.equal(authorization, `Bearer ${TOKEN_A}`);
    assert.notEqual(authorization, 'Bearer token-global-inválido');
  } finally {
    global.fetch = oldFetch;
    db.getConnection = oldGetConnection;
  }
});

test('Meta: download de mídia usa o token do tenant dono', async () => {
  const oldGetConnection = db.getConnection;
  const oldFetch = global.fetch;
  db.getConnection = async () => ({
    async execute(_sql, binds) {
      assert.equal(binds.phone, 'PN-A');
      assert.equal(binds.tenantId, A);
      return { rows: [{ TENANT_ID: A, PHONE_NUMBER_ID: 'PN-A', WABA_ID: 'WA-A', ACCESS_TOKEN_CRIPTOGRAFADO: criptografar(TOKEN_A, A, undefined, CONTEXTO) }] };
    },
    async close() {},
  });
  const authorizations = [];
  global.fetch = async (url, options) => {
    authorizations.push(options.headers.Authorization);
    if (String(url).endsWith('/media-A')) {
      return { ok: true, json: async () => ({ url: 'https://lookaside.fbsbx.com/file-A', mime_type: 'image/jpeg', file_size: 3 }) };
    }
    return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  };
  try {
    delete require.cache[require.resolve('../graph/media')];
    delete require.cache[require.resolve('../graph/client')];
    const { downloadMedia } = require('../graph/media');
    const result = await downloadMedia({ id: 'media-A', mime_type: 'image/jpeg' }, {
      phoneNumberId: 'PN-A', tenantId: A, conversaId: 7,
    });
    assert.equal(result.size, 3);
    assert.deepEqual(authorizations, [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_A}`]);
    await storage.remover(result.caminho);
  } finally {
    global.fetch = oldFetch;
    db.getConnection = oldGetConnection;
  }
});

test('Meta: fallback WA_TOKEN só funciona com DEV_META_FALLBACK=1', () => {
  const { loadConfig } = require('../config');
  process.env.NODE_ENV = 'development';
  process.env.WA_TOKEN = 'token-global-inválido';
  process.env.DEV_META_FALLBACK = '0';
  assert.equal(loadConfig({ requireDb: false }).devMetaFallback, false);
  process.env.DEV_META_FALLBACK = '1';
  assert.equal(loadConfig({ requireDb: false }).devMetaFallback, true);
  process.env.DEV_META_FALLBACK = '0';
});
