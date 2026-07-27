// Testes do endpoint de CONTAGEM real do Monitor: GET /api/conversas/contagens.
// Conta via COUNT no banco (sem o teto de 100 da listagem) e é gestor-only.
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

const TOKEN = jwt.sign({ jti: 'tc1', tenantId: 1, matricula: 123, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

function startApp(conn, perfil) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.perfil = perfil; next(); }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function req(port, method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { method, hostname: '127.0.0.1', port, path, headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); }
    );
    r.on('error', reject); r.end();
  });
}

// Cenário com 118 em atendimento (100 no depto 4 + 18 sem departamento) — exatamente
// o caso que a listagem limitada a 100 escondia.
function fakeConn(capturas = []) {
  return {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('GROUP BY NVL(DEPARTAMENTO_ID')) {
        return { rows: [
          { DEP: 4, FILA_STATUS: 'em_atendimento', QTD: 100 },
          { DEP: 4, FILA_STATUS: 'aguardando', QTD: 3 },
          { DEP: 0, FILA_STATUS: 'em_atendimento', QTD: 18 },
        ] };
      }
      if (sql.includes('GROUP BY ATENDENTE_ID')) {
        return { rows: [{ ATD: 9, QTD: 73 }, { ATD: 11, QTD: 27 }] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

const ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true };

test('contagens: ADMIN recebe a soma REAL por depto (inclui em_atendimento sem departamento)', async () => {
  const { server, port } = await startApp(fakeConn(), ADMIN);
  try {
    const r = await req(port, 'GET', '/api/conversas/contagens');
    assert.equal(r.status, 200);
    assert.equal(r.body.porDepartamento['4'].em_atendimento, 100);
    assert.equal(r.body.porDepartamento['4'].aguardando, 3);
    assert.equal(r.body.porDepartamento['0'].em_atendimento, 18);
    // O total bate com o Histórico (118) — não fica preso no teto de 100.
    const totalAtend = Object.values(r.body.porDepartamento).reduce((s, d) => s + (d.em_atendimento || 0), 0);
    assert.equal(totalAtend, 118);
    assert.equal(r.body.porAtendente['9'], 73);
    assert.equal(r.body.porAtendente['11'], 27);
  } finally { server.close(); }
});

test('contagens: SUPERVISOR pode (200)', async () => {
  const { server, port } = await startApp(fakeConn(), { atendenteId: 2, papel: 'SUPERVISOR', deptoIds: [4], ativo: true });
  try {
    const r = await req(port, 'GET', '/api/conversas/contagens');
    assert.equal(r.status, 200);
  } finally { server.close(); }
});

test('contagens: ATENDENTE comum é bloqueado (403)', async () => {
  const { server, port } = await startApp(fakeConn(), { atendenteId: 9, papel: 'ATENDENTE', deptoIds: [4], ativo: true });
  try {
    const r = await req(port, 'GET', '/api/conversas/contagens');
    assert.equal(r.status, 403);
  } finally { server.close(); }
});
