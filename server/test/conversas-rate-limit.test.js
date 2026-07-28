// Testes de fio (wiring) do rate limit nas rotas de custo real de conversas.js:
// POST /:id/sugestao-resposta (B2, custa no provedor de IA) e POST
// /:id/mensagens + /:id/arquivos (B3, custam na Cloud API da Meta — dividem o
// MESMO teto por usuário). O comportamento do middleware em si (por usuário,
// não por IP) já está coberto em rateLimitPorUsuario.test.js; aqui só provamos
// que as rotas certas estão protegidas, usando uma matrícula/tenant exclusivos
// deste arquivo para não herdar contagem de outro teste da suíte.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.DEV_META_FALLBACK = '1';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');

// Matrícula/tenant EXCLUSIVOS deste arquivo — nenhum outro teste da suíte usa
// esse par, então o bucket do rate limit (por tenantId+matrícula) começa zerado.
const TENANT_ID = 555;
const TOKEN = jwt.sign({ jti: 'rl1', tenantId: TENANT_ID, matricula: 555555, nome: 'RateLimit' }, SECRET, { expiresIn: '1h' });

const SUGESTAO_IA_MAX = Number(process.env.SUGESTAO_IA_RATE_LIMIT_MAX) || 20;
const ENVIO_MAX = Number(process.env.ENVIO_RATE_LIMIT_MAX) || 60;

function fakeConn() {
  return {
    async execute(sql) {
      // sugestao-resposta: qualquer conversa existe, recurso sempre "não incluído
      // no plano" — 400 rápido, sem tocar provedor de IA nenhum.
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: 2, ATENDENTE_ID: null }] };
      }
      // mensagens: conversa com janela FECHADA — 409 rápido, sem chamar a Graph API.
      if (sql.includes('FROM conversa c')) {
        return { rows: [{ ID: 7, CONTATO_ID: 3, NUMERO_ID: 2, JANELA_EXPIRA_EM: new Date(Date.now() - 1000), TELEFONE: '5562999990000', PHONE_NUMBER_ID: '5550009999' }] };
      }
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
    async close() {},
  };
}

function startApp() {
  db.getConnection = async () => fakeConn();
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.tenantId = TENANT_ID; next(); }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function post(port, path) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ texto: 'oi' });
    const req = http.request(
      {
        method: 'POST', hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` },
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

test(`sugestao-resposta: acima de ${SUGESTAO_IA_MAX}/hora por usuário → 429`, async () => {
  const { server, port } = await startApp();
  try {
    for (let i = 0; i < SUGESTAO_IA_MAX; i++) {
      const r = await post(port, '/api/conversas/7/sugestao-resposta');
      assert.notEqual(r.status, 429, `requisição ${i + 1} não deveria ser limitada ainda`);
    }
    const bloqueada = await post(port, '/api/conversas/7/sugestao-resposta');
    assert.equal(bloqueada.status, 429);
    assert.match(bloqueada.body.error, /sugest/i);
  } finally { server.close(); }
});

test(`mensagens/arquivos: acima de ${ENVIO_MAX}/min por usuário → 429 (mesmo teto nas duas rotas)`, async () => {
  const { server, port } = await startApp();
  try {
    for (let i = 0; i < ENVIO_MAX; i++) {
      const r = await post(port, '/api/conversas/7/mensagens');
      assert.notEqual(r.status, 429, `requisição ${i + 1} não deveria ser limitada ainda`);
    }
    const bloqueadaMsg = await post(port, '/api/conversas/7/mensagens');
    assert.equal(bloqueadaMsg.status, 429);

    // /arquivos divide o MESMO teto (mesmo usuário já estourou em /mensagens).
    const bloqueadaArquivo = await post(port, '/api/conversas/7/arquivos');
    assert.equal(bloqueadaArquivo.status, 429);
  } finally { server.close(); }
});
