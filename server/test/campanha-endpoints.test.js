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
const campanhasRoutes = require('../api/campanhas');
const TOKEN = jwt.sign({ jti: 'tc-new', tenantId: 1, matricula: 1 }, SECRET, { expiresIn: '1h' });
const ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [] };

function appFake(conn, tenantId = 7, capturas = []) {
  db.comTenant = async (tid, fn) => { capturas.push(tid); return fn(conn); };
  const app = express(); app.use(express.json());
  app.use('/api/campanhas', (req, res, next) => { req.tenantId = tenantId; req.perfil = ADMIN; req.user = { matricula: 1 }; next(); }, campanhasRoutes);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve({ s, port: s.address().port })); });
}
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ method, hostname: '127.0.0.1', port, path, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => { let out = ''; res.on('data', (c) => out += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test('SQL livre é rejeitado na criação', async () => {
  const { s, port } = await appFake({ async execute() { throw new Error('não deveria tocar o banco'); } });
  try { const r = await request(port, 'POST', '/api/campanhas', { nome: 'x', segmento: { sql: 'SELECT * FROM contato' } }); assert.equal(r.status, 400); }
  finally { s.close(); }
});

test('importação devolve relatório linha a linha e respeita tenant recebido', async () => {
  const calls = []; const conn = { async execute(sql) {
    calls.push(sql);
    if (sql.includes('SELECT STATUS, SEGMENTO')) return { rows: [{ STATUS: 'rascunho', SEGMENTO: { tipo: 'csv', variaveis: ['nome'] } }] };
    return { rows: [], rowsAffected: 1 };
  } };
  const { s, port } = await appFake(conn, 42, calls);
  try {
    const r = await request(port, 'POST', '/api/campanhas/4/import', { csv: 'telefone,nome\n5562999990000,A\n,sem\n5562999990000,dup' });
    assert.equal(r.status, 200); assert.equal(r.body.aceitas, 1); assert.equal(r.body.rejeitadas, 2); assert.deepEqual(calls[0], 42);
  } finally { s.close(); }
});

test('preparar cria itens apenas dos contatos aceitos e não cria para opt-out', async () => {
  const inserts = []; const conn = { async execute(sql, binds) {
    if (sql.includes('SELECT STATUS, SEGMENTO')) return { rows: [{ STATUS: 'rascunho', SEGMENTO: { tipo: 'csv' } }] };
    if (sql.includes('FROM campanha_import_linha')) return { rows: [{ TELEFONE: '5562999990000', VARIAVEIS: ['A'] }, { TELEFONE: '5562888887777', VARIAVEIS: ['B'] }] };
    if (sql.includes('SELECT ct.OPTIN')) return { rows: binds.ot0 === '5562888887777' ? [{ OPTIN: 'N' }] : [] };
    if (sql.startsWith('INSERT INTO campanha_item')) inserts.push(binds);
    return { rows: [], rowsAffected: 1 };
  } };
  const { s, port } = await appFake(conn);
  try { const r = await request(port, 'POST', '/api/campanhas/4/preparar', {}); assert.equal(r.status, 200); assert.equal(r.body.inseridos, 1); assert.equal(inserts.length, 1); }
  finally { s.close(); }
});
