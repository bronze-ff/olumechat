'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');
const campanhasRoutes = require('../api/campanhas');

const ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [] };

function appFake(conn, tenantId = 7, perfil = ADMIN, calls = []) {
  db.comTenant = async (tid, fn) => { calls.push(tid); return fn(conn); };
  const app = express();
  app.use(express.json());
  app.use('/api/campanhas', (req, res, next) => {
    req.tenantId = tenantId; req.perfil = perfil; req.user = { matricula: 1 }; next();
  }, campanhasRoutes);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, hostname: '127.0.0.1', port, path }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
    });
    req.on('error', reject); req.end();
  });
}

test('permission regression: ATENDENTE receives 403', async () => {
  const { server, port } = await appFake({ async execute() { throw new Error('database should not be called'); } }, 7, { papel: 'ATENDENTE' });
  try { assert.equal((await request(port, 'GET', '/api/campanhas')).status, 403); }
  finally { server.close(); }
});

test('tenant regression: campaign queries use req.tenantId', async () => {
  const calls = [];
  const { server, port } = await appFake({ async execute() { return { rows: [] }; } }, 42, ADMIN, calls);
  try { await request(port, 'GET', '/api/campanhas'); assert.deepEqual(calls, [42]); }
  finally { server.close(); }
});

test('unknown segment type returns an explicit error', async () => {
  const conn = { async execute(sql) {
    if (sql.includes('SELECT SEGMENTO FROM campanha')) return { rows: [{ SEGMENTO: { tipo: 'unknown' } }] };
    throw new Error('unexpected database query');
  } };
  const { server, port } = await appFake(conn);
  try {
    const response = await request(port, 'POST', '/api/campanhas/4/preview');
    assert.equal(response.status, 400);
    assert.match(response.body.error, /Tipo de segmento inválido/);
  } finally { server.close(); }
});
