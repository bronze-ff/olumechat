// Testes da fronteira de tenant no auth/middleware.js (FIL-67).
//
// Critérios de aceite cobertos:
//  • JWT sem tenant_id é REJEITADO (não vira "tenant padrão");
//  • tenant_id vindo de header, query string ou corpo é IGNORADO — vale só o
//    do token;
//  • o middleware alimenta AS DUAS convenções (req.tenantId e
//    req.user.tenantId) com o mesmo valor.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
// A blacklist deste teste usa deliberadamente o cache local; não deve gravar
// no banco de desenvolvimento configurado na máquina que executa a suíte.
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { SECRET } = require('../auth/secret');
const blacklist = require('../utils/tokenBlacklist');
const auth = require('../auth/middleware');

function token(payload, opts = {}) {
  return jwt.sign(payload, SECRET, { expiresIn: '1h', ...opts });
}

/** App mínimo que devolve o que o middleware deixou no req. */
function startApp() {
  const app = express();
  app.use(express.json());
  app.all('/eco', auth, (req, res) => {
    res.json({ tenantId: req.tenantId, userTenantId: req.user.tenantId, matricula: req.user.matricula });
  });
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function req(port, path, { tok, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      { method: body === undefined ? 'GET' : 'POST', hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json',
                   ...(tok ? { authorization: `Bearer ${tok}` } : {}),
                   ...headers,
                   ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let ctx;
test.before(async () => { ctx = await startApp(); });
test.after(() => ctx && ctx.server.close());

test('token com tenantId passa e alimenta as DUAS convenções', async () => {
  const r = await req(ctx.port, '/eco', { tok: token({ jti: 'a', tenantId: 7, matricula: 10 }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.tenantId, 7);
  assert.equal(r.body.userTenantId, 7, 'fila/stream leem req.user.tenantId');
});

// ---------------------------------------------------------------------------
// AC: JWT sem tenant_id é rejeitado.
// ---------------------------------------------------------------------------
test('JWT sem tenantId é rejeitado com 401 — não existe tenant padrão', async () => {
  const r = await req(ctx.port, '/eco', { tok: token({ jti: 'b', matricula: 10 }) });
  assert.equal(r.status, 401);
});

test('tenantId inválido no token (0, negativo, texto, nulo) é rejeitado', async () => {
  for (const valor of [0, -1, '', 'acme', null, 1.5, '2; DROP TABLE usuario', Number.MAX_SAFE_INTEGER + 2]) {
    const r = await req(ctx.port, '/eco', { tok: token({ jti: 'c', tenantId: valor, matricula: 10 }) });
    assert.equal(r.status, 401, `tenantId ${JSON.stringify(valor)} deveria ser rejeitado`);
  }
});

test('tenantId numérico em string é aceito e normalizado para número', async () => {
  const r = await req(ctx.port, '/eco', { tok: token({ jti: 'd', tenantId: '7', matricula: 10 }) });
  assert.equal(r.status, 200);
  assert.strictEqual(r.body.tenantId, 7, 'comTenant() recebe número, não string');
});

// ---------------------------------------------------------------------------
// AC: tenant_id por header/query/body é ignorado.
// ---------------------------------------------------------------------------
test('tenant_id por header, query string e corpo é IGNORADO — vale só o do token', async () => {
  const tok = token({ jti: 'e', tenantId: 7, matricula: 10 });
  const r = await req(ctx.port, '/eco?tenant_id=99&tenantId=99', {
    tok,
    headers: { 'x-tenant-id': '99', 'x-tenant': '99' },
    body: { tenant_id: 99, tenantId: 99 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.tenantId, 7, 'o tenant veio de fora do token — VAZAMENTO');
  assert.equal(r.body.userTenantId, 7, 'o tenant veio de fora do token — VAZAMENTO');
});

test('sem token, token forjado com outro segredo e algoritmo "none" → 401', async () => {
  assert.equal((await req(ctx.port, '/eco')).status, 401);

  const outroSegredo = jwt.sign({ jti: 'f', tenantId: 7 }, 'segredo-do-atacante', { expiresIn: '1h' });
  assert.equal((await req(ctx.port, '/eco', { tok: outroSegredo })).status, 401);

  const none = jwt.sign({ jti: 'g', tenantId: 7 }, '', { algorithm: 'none' });
  assert.equal((await req(ctx.port, '/eco', { tok: none })).status, 401);
});

test('token expirado → 401', async () => {
  const r = await req(ctx.port, '/eco', { tok: token({ jti: 'h', tenantId: 7 }, { expiresIn: '-1s' }) });
  assert.equal(r.status, 401);
});

test('JWT sem exp rejeitado antes da blacklist', async () => {
  const tok = jwt.sign({ jti: 'sem-exp', tenantId: 7, matricula: 10 }, SECRET);
  const r = await req(ctx.port, '/eco', { tok });
  assert.equal(r.status, 401);
});

test('jti na blacklist → 401 mesmo com tenantId válido', async () => {
  await blacklist.add('revogado', Math.floor(Date.now() / 1000) + 3600, { tenantId: 7 });
  const r = await req(ctx.port, '/eco', { tok: token({ jti: 'revogado', tenantId: 7, matricula: 10 }) });
  assert.equal(r.status, 401);
});
