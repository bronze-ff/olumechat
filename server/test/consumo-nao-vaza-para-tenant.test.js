// FIL-77 — critério de aceite: "nenhuma rota de tenant devolve
// custo/tokens/preço" (ver docs/SEGURANCA.md: o cliente nunca vê o que a IA
// custou nem o que ele consumiu em tokens — só o operador, em
// /api/operador/*). Verifica as respostas JSON das rotas de tenant que este
// ticket tocou (envio de texto, envio de arquivo, sugestão de resposta) e a
// de status de IA do tenant.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.DEV_META_FALLBACK = '1';
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
const iaConfigRoutes = require('../api/iaConfig');
const iaConfigStore = require('../ia/iaConfigStore');
const { criptografar } = require('../ia/crypto');

const TENANT_ID = 6001;
const TOKEN = jwt.sign({ jti: 'nv1', tenantId: TENANT_ID, matricula: 1, nome: 'Ana' }, SECRET, { expiresIn: '1h' });

// Campos que uma rota de TENANT nunca pode devolver (ver docs/SEGURANCA.md).
const PROIBIDOS = ['custo', 'custoCentavos', 'tokens', 'tokensEntrada', 'tokensSaida', 'precoEntradaCentavos1k', 'precoSaidaCentavos1k', 'apiKey'];

function assertSemCamposProibidos(body, contexto) {
  const chaves = JSON.stringify(body || {});
  for (const proibido of PROIBIDOS) {
    assert.ok(!new RegExp(`"${proibido}"`, 'i').test(chaves), `${contexto} vazou o campo "${proibido}": ${chaves}`);
  }
}

function fakeConn({ janelaExpiraEm } = {}) {
  return {
    async execute(sql, binds) {
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: 2, ATENDENTE_ID: null }] };
      }
      if (sql.includes('FROM conversa c')) {
        return { rows: [{ ID: 7, CONTATO_ID: 3, NUMERO_ID: 2, JANELA_EXPIRA_EM: janelaExpiraEm, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '5550009999' }] };
      }
      if (sql.includes('ia_habilitada FROM tenant')) return { rows: [{ IA_HABILITADA: 'S' }] };
      if (sql.includes("chave = 'ia_sugestao_ativa'")) return { rows: [{ VALOR: 'S' }] };
      if (sql.includes('FROM ia_config')) {
        return { rows: [{ PROVIDER: 'anthropic', MODELO: 'claude-x', BASE_URL: null, API_KEY_CRIPTOGRAFADA: criptografar('sk-fake', TENANT_ID) }] };
      }
      if (sql.includes('FROM mensagem')) return { rows: [{ DIRECAO: 'in', CONTEUDO: 'Olá' }] };
      if (sql.includes('FROM atendente')) return { rows: [{ ID: 9 }] };
      if (sql.startsWith('INSERT INTO mensagem')) return { outBinds: { id: [42] } };
      return { rows: [] };
    },
    async commit() {}, async rollback() {}, async close() {},
  };
}

function startApp(conn, routes = conversasRoutes, base = '/api/conversas') {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use(base, authMiddleware, (req, res, next) => { req.tenantId = TENANT_ID; next(); }, routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', hostname: '127.0.0.1', port, path, headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); }
    );
    req.on('error', reject); req.end();
  });
}

test('POST /api/conversas/:id/mensagens não devolve custo/tokens/preço', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }) });
  const { server, port } = await startApp(fakeConn({ janelaExpiraEm: new Date(Date.now() + 60_000) }));
  try {
    const r = await post(port, '/api/conversas/7/mensagens', { texto: 'oi' });
    assert.equal(r.status, 201);
    assertSemCamposProibidos(r.body, 'POST /mensagens');
  } finally { server.close(); }
});

test('POST /api/conversas/:id/sugestao-resposta não devolve custo/tokens/preço (mesmo quando o provedor devolve usage)', async () => {
  iaConfigStore.invalidar(TENANT_ID);
  global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Claro!' }], usage: { input_tokens: 300, output_tokens: 80 } }) });
  const { server, port } = await startApp(fakeConn());
  try {
    const r = await post(port, '/api/conversas/7/sugestao-resposta', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body), ['sugestao'], 'a rota só pode devolver o campo sugestao');
    assertSemCamposProibidos(r.body, 'POST /sugestao-resposta');
  } finally {
    server.close();
    iaConfigStore.invalidar(TENANT_ID);
  }
});

test('GET /api/ia-config (status de IA do tenant) não devolve custo/tokens/preço/apiKey', async () => {
  const { server, port } = await startApp(fakeConn(), iaConfigRoutes, '/api/ia-config');
  try {
    const r = await get(port, '/api/ia-config');
    assert.equal(r.status, 200);
    assertSemCamposProibidos(r.body, 'GET /ia-config');
  } finally { server.close(); }
});
