// Testes do DELETE /api/fluxos/:id (exclusão segura de fluxo).
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
const fluxosRoutes = require('../api/fluxos');

const TOKEN = jwt.sign({ jti: 'tf1', matricula: 1, nome: 'Adm' }, SECRET, { expiresIn: '1h' });
const ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [] };
const TENANT_ID = 1;

// db.comTenant chama execute() p/ SET LOCAL ROLE e set_config antes da lógica de
// negócio — o mock devolve { rows: [] } por padrão nesses dois, então basta que
// todo conn de teste tenha commit/rollback/close (comTenant sempre chama commit
// no sucesso e close no finally).
function conn(handler) {
  return {
    async execute(sql, binds) { return handler(sql, binds) || { rows: [] }; },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function startApp(c, perfil) {
  db.getConnection = async () => c;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/fluxos', authMiddleware, (req, res, next) => {
    req.perfil = perfil;
    req.tenantId = TENANT_ID;
    next();
  }, fluxosRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, port: s.address().port })); });
}

function del(port, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method: 'DELETE', hostname: '127.0.0.1', port, path,
      headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); });
    r.on('error', reject); r.end();
  });
}

test('delete: SUPERVISOR recebe 403', async () => {
  const { server, port } = await startApp(conn(() => ({ rows: [] })),
    { atendenteId: 2, papel: 'SUPERVISOR', deptoIds: [1] });
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

test('delete: fluxo ATIVO retorna 409', async () => {
  const c = conn((sql) => {
    if (sql.includes('SELECT nome, ativo')) return { rows: [{ NOME: 'Menu', ATIVO: 'S' }] };
  });
  const { server, port } = await startApp(c, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /ATIVO/);
  } finally { server.close(); }
});

test('delete: conversa em autoatendimento no fluxo retorna 409', async () => {
  const c = conn((sql) => {
    if (sql.includes('SELECT nome, ativo')) return { rows: [{ NOME: 'Menu', ATIVO: 'N' }] };
    if (sql.includes("fila_status = 'bot'")) return { rows: [{ QTD: 2 }] };
  });
  const { server, port } = await startApp(c, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /autoatendimento/);
  } finally { server.close(); }
});

test('delete: referenciado por irfluxo de outro fluxo retorna 409', async () => {
  const def = { versao: 1, config: {}, nos: [{ id: 'x', tipo: 'irfluxo', fluxo: 'Menu Financeiro' }] };
  const c = conn((sql) => {
    if (sql.includes('SELECT nome, ativo')) return { rows: [{ NOME: 'Menu Financeiro', ATIVO: 'N' }] };
    if (sql.includes("fila_status = 'bot'")) return { rows: [{ QTD: 0 }] };
    if (sql.includes('upper(nome)')) return { rows: [{ QTD: 0 }] }; // único com esse nome
    if (sql.includes('SELECT id, nome, definicao')) return { rows: [{ ID: 9, NOME: 'Menu Principal', DEFINICAO: def }] };
  });
  const { server, port } = await startApp(c, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Menu Principal/);
  } finally { server.close(); }
});

test('delete: homônimo permanece → versão antiga PODE ser excluída (irfluxo segue resolvendo)', async () => {
  const def = { versao: 1, config: {}, nos: [{ id: 'x', tipo: 'irfluxo', fluxo: 'Menu Financeiro' }] };
  const sqls = [];
  const c = conn((sql) => {
    sqls.push(sql);
    if (sql.includes('SELECT nome, ativo')) return { rows: [{ NOME: 'Menu Financeiro', ATIVO: 'N' }] };
    if (sql.includes("fila_status = 'bot'")) return { rows: [{ QTD: 0 }] };
    if (sql.includes('upper(nome)')) return { rows: [{ QTD: 1 }] }; // existe a versão nova
    if (sql.includes('SELECT id, nome, definicao')) return { rows: [{ ID: 9, NOME: 'Menu Principal', DEFINICAO: def }] };
    return { rows: [], rowsAffected: 1 };
  });
  const { server, port } = await startApp(c, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 200);
    assert.ok(sqls.some((s) => s.startsWith('DELETE FROM fluxo')));
  } finally { server.close(); }
});

test('delete: sucesso limpa BOT_FLUXO_ID histórico e apaga o fluxo', async () => {
  const sqls = [];
  const c = conn((sql) => {
    sqls.push(sql);
    if (sql.includes('SELECT nome, ativo')) return { rows: [{ NOME: 'menu principal', ATIVO: 'N' }] };
    if (sql.includes("fila_status = 'bot'")) return { rows: [{ QTD: 0 }] };
    if (sql.includes('upper(nome)')) return { rows: [{ QTD: 0 }] };
    if (sql.includes('SELECT id, nome, definicao')) return { rows: [] }; // nenhum outro fluxo
    return { rows: [], rowsAffected: 1 };
  });
  const { server, port } = await startApp(c, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(sqls.some((s) => s.includes('SET bot_fluxo_id = NULL')));
    assert.ok(sqls.some((s) => s.startsWith('DELETE FROM fluxo')));
    assert.ok(sqls.some((s) => s.includes("'fluxo_excluido'")));
  } finally { server.close(); }
});
