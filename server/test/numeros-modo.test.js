// PUT /api/numeros/:id — seletor de MODO (padrao/ia) do bot de IA.
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
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const numerosRoutes = require('../api/numeros');

const TOKEN = jwt.sign({ jti: 'n1', matricula: 1, nome: 'Admin' }, SECRET, { expiresIn: '1h' });
const PERFIL_ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true };

function startApp(conn, perfil) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/numeros', authMiddleware, (req, res, next) => { req.perfil = perfil; req.tenantId = 1; next(); }, numerosRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function req(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { method, hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`,
                   ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); }
    );
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

function fakeConn(capturas) {
  return {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      return { rows: [], rowsAffected: 1, outBinds: { id: [1] } };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('PUT /numeros/:id aceita modo=ia e grava MODO', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn(capturas), PERFIL_ADMIN);
  try {
    const r = await req(port, 'PUT', '/api/numeros/7', { modo: 'ia' });
    assert.equal(r.status, 200);
    const upd = capturas.find((c) => c.sql.includes('UPDATE numero'));
    assert.match(upd.sql, /modo\s+=\s+COALESCE\(:modo, modo\)/);
    assert.equal(upd.binds.modo, 'ia');
  } finally { server.close(); }
});

test('PUT /numeros/:id volta pra modo=padrao', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn(capturas), PERFIL_ADMIN);
  try {
    const r = await req(port, 'PUT', '/api/numeros/7', { modo: 'padrao' });
    assert.equal(r.status, 200);
    const upd = capturas.find((c) => c.sql.includes('UPDATE numero'));
    assert.equal(upd.binds.modo, 'padrao');
  } finally { server.close(); }
});

test('PUT /numeros/:id ignora modo invalido (bind vira null, nao altera coluna)', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn(capturas), PERFIL_ADMIN);
  try {
    const r = await req(port, 'PUT', '/api/numeros/7', { modo: 'qualquer' });
    assert.equal(r.status, 200);
    const upd = capturas.find((c) => c.sql.includes('UPDATE numero'));
    assert.equal(upd.binds.modo, null);
  } finally { server.close(); }
});
