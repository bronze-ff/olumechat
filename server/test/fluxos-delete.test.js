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

function startApp(conn, perfil) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/fluxos', authMiddleware, (req, res, next) => { req.perfil = perfil; next(); }, fluxosRoutes);
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
  const { server, port } = await startApp({ async execute() { return { rows: [] }; }, close: async () => {} },
    { atendenteId: 2, papel: 'SUPERVISOR', deptoIds: [1] });
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

test('delete: fluxo ATIVO retorna 409', async () => {
  const conn = {
    async execute(sql) {
      if (sql.includes('SELECT NOME, ATIVO')) return { rows: [{ NOME: 'Menu', ATIVO: 'S' }] };
      return { rows: [] };
    },
    close: async () => {},
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /ATIVO/);
  } finally { server.close(); }
});

test('delete: conversa em autoatendimento no fluxo retorna 409', async () => {
  const conn = {
    async execute(sql) {
      if (sql.includes('SELECT NOME, ATIVO')) return { rows: [{ NOME: 'Menu', ATIVO: 'N' }] };
      if (sql.includes("FILA_STATUS = 'bot'")) return { rows: [{ QTD: 2 }] };
      return { rows: [] };
    },
    close: async () => {},
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /autoatendimento/);
  } finally { server.close(); }
});

test('delete: referenciado por irfluxo de outro fluxo retorna 409', async () => {
  const def = JSON.stringify({ versao: 1, config: {}, nos: [{ id: 'x', tipo: 'irfluxo', fluxo: 'Menu Financeiro' }] });
  const conn = {
    async execute(sql) {
      if (sql.includes('SELECT NOME, ATIVO')) return { rows: [{ NOME: 'Menu Financeiro', ATIVO: 'N' }] };
      if (sql.includes("FILA_STATUS = 'bot'")) return { rows: [{ QTD: 0 }] };
      if (sql.includes('UPPER(NOME)')) return { rows: [{ QTD: 0 }] }; // único com esse nome
      if (sql.includes('SELECT ID, NOME, DEFINICAO')) return { rows: [{ ID: 9, NOME: 'Menu Principal', DEFINICAO: def }] };
      return { rows: [] };
    },
    close: async () => {},
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Menu Principal/);
  } finally { server.close(); }
});

test('delete: homônimo permanece → versão antiga PODE ser excluída (irfluxo segue resolvendo)', async () => {
  const def = JSON.stringify({ versao: 1, config: {}, nos: [{ id: 'x', tipo: 'irfluxo', fluxo: 'Menu Financeiro' }] });
  const sqls = [];
  const conn = {
    async execute(sql) {
      sqls.push(sql);
      if (sql.includes('SELECT NOME, ATIVO')) return { rows: [{ NOME: 'Menu Financeiro', ATIVO: 'N' }] };
      if (sql.includes("FILA_STATUS = 'bot'")) return { rows: [{ QTD: 0 }] };
      if (sql.includes('UPPER(NOME)')) return { rows: [{ QTD: 1 }] }; // existe a versão nova
      if (sql.includes('SELECT ID, NOME, DEFINICAO')) return { rows: [{ ID: 9, NOME: 'Menu Principal', DEFINICAO: def }] };
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 200);
    assert.ok(sqls.some((s) => s.startsWith('DELETE FROM MC_ZAP_FLUXO')));
  } finally { server.close(); }
});

test('delete: sucesso limpa BOT_FLUXO_ID histórico e apaga o fluxo', async () => {
  const sqls = [];
  const conn = {
    async execute(sql) {
      sqls.push(sql);
      if (sql.includes('SELECT NOME, ATIVO')) return { rows: [{ NOME: 'menu principal', ATIVO: 'N' }] };
      if (sql.includes("FILA_STATUS = 'bot'")) return { rows: [{ QTD: 0 }] };
      if (sql.includes('UPPER(NOME)')) return { rows: [{ QTD: 0 }] };
      if (sql.includes('SELECT ID, NOME, DEFINICAO')) return { rows: [] }; // nenhum outro fluxo
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await del(port, '/api/fluxos/5');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(sqls.some((s) => s.includes('SET BOT_FLUXO_ID = NULL')));
    assert.ok(sqls.some((s) => s.startsWith('DELETE FROM MC_ZAP_FLUXO')));
    assert.ok(sqls.some((s) => s.includes("'fluxo_excluido'")));
  } finally { server.close(); }
});
