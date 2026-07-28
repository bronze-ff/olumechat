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
const historicoRoutes = require('../api/historico');

const TOKEN = jwt.sign(
  { jti: 'hist-me', tenantId: 1, matricula: 123, nome: 'Atendente' },
  SECRET,
  { expiresIn: '1h' }
);

function startApp(perfil, rows = []) {
  let consulta = null;
  db.comTenant = async (tenantId, fn) => fn({
    execute: async (sql, binds) => {
      if (/token_blacklist/i.test(sql)) return { rows: [] };
      consulta = { tenantId, sql, binds };
      return { rows };
    },
  });
  const app = express();
  app.use('/api/historico', authMiddleware, (req, res, next) => {
    req.perfil = perfil;
    next();
  }, historicoRoutes);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      server,
      port: server.address().port,
      consulta: () => consulta,
    }));
  });
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'GET',
      hostname: '127.0.0.1',
      port,
      path,
      headers: { authorization: `Bearer ${TOKEN}` },
    }, (res) => {
      let output = '';
      res.on('data', (chunk) => { output += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(output || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/historico/me limita a consulta ao atendente autenticado', async () => {
  const rows = [{
    ID: 44,
    PROTOCOLO: '20260044',
    FILA_STATUS: 'resolvida',
    NOME_PERFIL: 'Ana Martins',
    TELEFONE: '5511999999999',
    CRIADO_EM: new Date('2026-07-28T10:00:00Z'),
  }];
  const ctx = await startApp({ atendenteId: 7, papel: 'ATENDENTE', deptoIds: [2] }, rows);
  try {
    const response = await request(ctx.port, '/api/historico/me?q=Ana');
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.itens[0].nomePerfil, 'Ana Martins');
    assert.equal(ctx.consulta().tenantId, 1);
    assert.equal(ctx.consulta().binds.atendenteId, 7);
    assert.match(ctx.consulta().sql, /au\.atendente_id = :atendenteId/);
  } finally {
    ctx.server.close();
  }
});

test('GET /api/historico/me recusa perfil sem atendente', async () => {
  const ctx = await startApp({ papel: 'ATENDENTE', deptoIds: [] });
  try {
    const response = await request(ctx.port, '/api/historico/me');
    assert.equal(response.status, 403);
    assert.equal(ctx.consulta(), null);
  } finally {
    ctx.server.close();
  }
});
