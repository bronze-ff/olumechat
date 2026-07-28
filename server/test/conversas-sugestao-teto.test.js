// FIL-78: POST /api/conversas/:id/sugestao-resposta bloqueia ANTES de chamar
// o provedor quando o tenant estourou o teto mensal do plano — mensagem
// clara, sem expor custo/tokens (ver ia/limitePlano.js).
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.JWT_SECRET = 'segredo-de-teste-com-mais-de-32-chars-1234567890';
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');

const TENANT_ID = 8888; // exclusivo deste arquivo — não colide com o cache do iaConfigStore
const TOKEN = jwt.sign({ jti: 'teto1', tenantId: TENANT_ID, matricula: 1, nome: 'Ana' }, SECRET, { expiresIn: '1h' });

function fakeConn({ teto = null, usados = 0 } = {}) {
  const chamouProvedor = { valor: false };
  return {
    chamouProvedor,
    async execute(sql) {
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: null, ATENDENTE_ID: null }] };
      }
      if (sql.includes('ia_habilitada FROM tenant')) return { rows: [{ IA_HABILITADA: 'S' }] };
      if (sql.includes('ia_teto_tokens_mes')) return { rows: teto === null ? [] : [{ IA_TETO_TOKENS_MES: teto }] };
      if (sql.includes('FROM ia_consumo_mensal')) return { rows: [{ TOKENS_USADOS: usados }] };
      if (sql.includes("chave = 'ia_sugestao_ativa'")) return { rows: [{ VALOR: 'S' }] };
      if (sql.includes('FROM ia_config')) return { rows: [] }; // sem chave própria — cairia no fallback global se chegasse lá
      return { rows: [] };
    },
    async commit() {}, async rollback() {}, async close() {},
  };
}

function startApp(conn) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.tenantId = TENANT_ID; next(); }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function post(port) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({});
    const req = http.request(
      {
        method: 'POST', hostname: '127.0.0.1', port, path: '/api/conversas/7/sugestao-resposta',
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

test('teto estourado: 400 com mensagem clara, SEM expor custo/tokens, e NÃO chama o provedor', async () => {
  const conn = fakeConn({ teto: 1000, usados: 1000 });
  const oldFetch = global.fetch;
  global.fetch = async () => { conn.chamouProvedor.valor = true; return { ok: true, json: async () => ({}) }; };
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port);
    assert.equal(r.status, 400);
    assert.ok(r.body.error, 'precisa de uma mensagem de erro');
    assert.ok(!/custo|token|R\$|\bUSD\b/i.test(r.body.error), `mensagem não pode expor custo/tokens: ${r.body.error}`);
    assert.equal(conn.chamouProvedor.valor, false, 'não pode chamar o provedor com o teto estourado');
  } finally {
    global.fetch = oldFetch;
    server.close();
  }
});

test('sem teto configurado (ia_teto_tokens_mes NULL): segue normalmente até o gate de config', async () => {
  const conn = fakeConn({ teto: null });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port);
    // Sem teto, o próximo gate é "nenhum provedor de IA configurado" (fakeConn
    // não tem chave própria nem credencial global mockada) — não pode ser o
    // gate do teto.
    assert.equal(r.status, 400);
    assert.ok(!/limite mensal/i.test(r.body.error || ''), `não deveria bloquear pelo teto: ${r.body.error}`);
  } finally {
    server.close();
  }
});

test('teto configurado mas AINDA não estourado: não bloqueia pelo teto', async () => {
  const conn = fakeConn({ teto: 1_000_000, usados: 10 });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port);
    assert.ok(!/limite mensal/i.test((r.body && r.body.error) || ''), `não deveria bloquear pelo teto: ${r.body && r.body.error}`);
  } finally {
    server.close();
  }
});
