// Testes de guarda do POST /api/conversas/:id/sugestao-resposta.
// A sessão de SUPORTE (implantação do operador) chega com req.perfil.papel
// 'ADMIN' — naoAuditor sozinho não barra. Esta rota gera custo real no
// provedor de IA e precisa bloquear req.user.suporte explicitamente (403).
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
const conversasRoutes = require('../api/conversas');

const TOKEN_SUPORTE = jwt.sign(
  { jti: 's1', tenantId: 1, suporte: true, operadorId: 999, email: 'operador@falatta.dev' },
  SECRET,
  { expiresIn: '1h' }
);

function fakeConn() {
  const executed = [];
  return {
    executed,
    async execute(sql, binds) {
      executed.push({ sql, binds });
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
    async close() {},
  };
}

function startApp(conn) {
  db.getConnection = async () => conn; // monkey-patch (mesma instância de módulo)
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.tenantId = 1; next(); }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function post(port, path, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({});
    const req = http.request(
      {
        method: 'POST', hostname: '127.0.0.1', port, path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('sugestao-resposta: sessão de SUPORTE recebe 403 (não gera custo de IA)', async () => {
  const conn = fakeConn();
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port, '/api/conversas/7/sugestao-resposta', TOKEN_SUPORTE);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /suporte/i);
    // Nunca chegou a consultar config/provedor de IA — barrado antes do handler.
    assert.ok(!conn.executed.some((e) => e.sql.includes('ia_habilitada')));
    assert.ok(!conn.executed.some((e) => e.sql.includes('ia_sugestao_ativa')));
  } finally { server.close(); }
});
