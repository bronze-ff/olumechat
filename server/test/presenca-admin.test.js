// Testes da ação do GESTOR de forçar a presença de um atendente:
// PUT /api/presenca/:atendenteId { estado }. Atua na MEMÓRIA da presença (não só
// no banco) — é o que tira o atendente da pausa na hora, sem F5.
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
const presence = require('../realtime/presence');
const presencaRoutes = require('../api/presenca');

// tenantId no JWT: mesmo contrato que auth/rbac.carregarPerfil(tenantId, ...)
// usa desde FIL-59 — aqui o perfil é injetado direto (abaixo), sem passar por
// carregarPerfil, mas presence.definirPausa/snapshot precisam de req.user.tenantId.
// Desde o FIL-67 o próprio auth/middleware.js rejeita token sem tenantId.
const TOKEN = jwt.sign({ jti: 'tp1', tenantId: 1, matricula: 123, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

function startApp(perfil) {
  // definirPausa persiste no banco via comTenant — basta um conn que aceita o UPDATE.
  db.comTenant = async (tenantId, fn) => fn({ execute: async () => ({ rowsAffected: 1 }) });
  const app = express();
  app.use('/api', express.json());
  app.use('/api/presenca', authMiddleware, (req, res, next) => { req.perfil = perfil; next(); }, presencaRoutes);
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

const ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [], matricula: 123 };

test('gestor tira atendente da pausa: 200 e a MEMÓRIA da presença vira online', async () => {
  presence._reset();
  // Atendente 9 conectado (SSE) e pausado → estado 'pausa'.
  presence.conectar({ atendenteId: 9, tenantId: 1, deptoIds: [4], numeroIds: [], matricula: 576, nome: 'Ana', pausado: true });
  assert.equal(presence.infoDe(9).estado, 'pausa');

  const { server, port } = await startApp(ADMIN);
  try {
    const r = await req(port, 'PUT', '/api/presenca/9', { estado: 'online' });
    assert.equal(r.status, 200);
    assert.equal(presence.infoDe(9).estado, 'online'); // mudou na hora, não só no banco
  } finally { server.close(); }
});

test('atendente comum não pode forçar a presença de outro (403)', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 9, tenantId: 1, deptoIds: [4], numeroIds: [], matricula: 576, nome: 'Ana', pausado: true });
  const { server, port } = await startApp({ atendenteId: 9, papel: 'ATENDENTE', deptoIds: [4], matricula: 123 });
  try {
    const r = await req(port, 'PUT', '/api/presenca/9', { estado: 'online' });
    assert.equal(r.status, 403);
    assert.equal(presence.infoDe(9).estado, 'pausa'); // nada mudou
  } finally { server.close(); }
});

test('forçar presença de quem NÃO está conectado → 409 (orienta a logar)', async () => {
  presence._reset();
  const { server, port } = await startApp(ADMIN);
  try {
    const r = await req(port, 'PUT', '/api/presenca/99', { estado: 'online' });
    assert.equal(r.status, 409);
  } finally { server.close(); }
});

test('estado inválido → 400', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 9, tenantId: 1, deptoIds: [4], numeroIds: [], matricula: 576, nome: 'Ana', pausado: true });
  const { server, port } = await startApp(ADMIN);
  try {
    const r = await req(port, 'PUT', '/api/presenca/9', { estado: 'sei la' });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});

test('GET /api/presenca: snapshot só mostra o tenant de quem pediu (isolamento)', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 1, tenantId: 1, deptoIds: [] }); // o próprio ADMIN, tenant 1
  presence.conectar({ atendenteId: 9, tenantId: 1, deptoIds: [4], matricula: 576, nome: 'Ana' }); // mesmo tenant
  presence.conectar({ atendenteId: 50, tenantId: 2, deptoIds: [4], matricula: 999, nome: 'De outro tenant' });
  const { server, port } = await startApp(ADMIN);
  try {
    const r = await req(port, 'GET', '/api/presenca');
    assert.equal(r.status, 200);
    const ids = r.body.map((x) => x.atendenteId);
    assert.ok(ids.includes(9));
    assert.equal(ids.includes(50), false); // outro tenant nunca aparece
  } finally { server.close(); }
});
