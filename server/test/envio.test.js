// Testes do endpoint de ENVIO (POST /api/conversas/:id/mensagens).
// Mocka o pool Oracle (monkey-patch) e a Graph API (global.fetch).
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

const TOKEN = jwt.sign({ jti: 't1', tenantId: 1, matricula: 123, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

function fakeConn({ janelaExpiraEm }) {
  const executed = [];
  return {
    executed,
    async execute(sql, binds) {
      executed.push({ sql, binds });
      // Guard de escopo (conversaNoEscopo): devolve a conversa p/ a checagem.
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: 2, ATENDENTE_ID: null }] };
      }
      if (sql.includes('FROM conversa c')) {
        return {
          rows: [{
            ID: 7, CONTATO_ID: 3, NUMERO_ID: 2, JANELA_EXPIRA_EM: janelaExpiraEm,
            TELEFONE: '5562999990000', PHONE_NUMBER_ID: '5550009999',
          }],
        };
      }
      if (sql.includes('FROM atendente')) return { rows: [{ ID: 9 }] };
      if (sql.startsWith('INSERT INTO mensagem')) return { outBinds: { id: [42] } };
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

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        method: 'POST', hostname: '127.0.0.1', port, path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          authorization: `Bearer ${TOKEN}`,
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

test('envio: janela ABERTA → envia pelo número da conversa e persiste (201)', async () => {
  let captured;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }) };
  };
  const conn = fakeConn({ janelaExpiraEm: new Date(Date.now() + 60 * 60 * 1000) });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port, '/api/conversas/7/mensagens', { texto: 'Olá do inbox' });
    assert.equal(r.status, 201);
    assert.equal(r.body.conteudo, 'Olá do inbox');
    assert.equal(r.body.wamid, 'wamid.OUT1');
    // Enviou pelo número DA CONVERSA (multi-número), não pelo default:
    assert.match(captured.url, /\/5550009999\/messages$/);
    // Persistiu a saída:
    assert.ok(conn.executed.some((e) => e.sql.startsWith('INSERT INTO mensagem')));
  } finally { server.close(); }
});

test('envio: janela FECHADA → 409 e NÃO chama a Graph API', async () => {
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const conn = fakeConn({ janelaExpiraEm: new Date(Date.now() - 1000) });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port, '/api/conversas/7/mensagens', { texto: 'tarde demais' });
    assert.equal(r.status, 409);
    assert.equal(called, false);
  } finally { server.close(); }
});

test('envio: texto vazio → 400', async () => {
  const conn = fakeConn({ janelaExpiraEm: new Date(Date.now() + 1000) });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port, '/api/conversas/7/mensagens', { texto: '   ' });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});
