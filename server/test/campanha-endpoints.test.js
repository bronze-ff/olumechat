// Testes dos endpoints de campanha: permissão, tenant, preview (read-only),
// preparar (dedup).
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
const campanhasRoutes = require('../api/campanhas');

const TOKEN = jwt.sign({ jti: 'tc1', matricula: 1, nome: 'Adm' }, SECRET, { expiresIn: '1h' });

// `db.comTenant` é mockado para rodar `fn(conn)` direto (sem BEGIN/COMMIT real)
// — o contrato do comTenant() em si já tem prova própria em db-tenant.test.js.
// Aqui capturamos o tenantId recebido para provar que a rota sempre repassa
// req.tenantId (nunca inventa um, nunca ignora).
function startApp(conn, perfil, { tenantId = 7, capturasTenant = [] } = {}) {
  db.comTenant = async (tid, fn) => { capturasTenant.push(tid); return fn(conn); };
  const app = express();
  app.use('/api', express.json());
  app.use('/api/campanhas', authMiddleware, (req, res, next) => {
    req.perfil = perfil;
    req.tenantId = tenantId;
    next();
  }, campanhasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, port: s.address().port })); });
}

function req(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, hostname: '127.0.0.1', port, path,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [], podeAtivo: true };

test('permissão: ATENDENTE recebe 403 em qualquer rota de campanha', async () => {
  const { server, port } = await startApp({ async execute() { return { rows: [] }; }, close: async () => {} },
    { atendenteId: 9, papel: 'ATENDENTE', deptoIds: [] });
  try {
    const r = await req(port, 'GET', '/api/campanhas');
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

test('tenant: toda chamada de banco roda dentro de db.comTenant(req.tenantId, ...)', async () => {
  const capturasTenant = [];
  const conn = { async execute() { return { rows: [] }; } };
  const { server, port } = await startApp(conn, ADMIN, { tenantId: 42, capturasTenant });
  try {
    await req(port, 'GET', '/api/campanhas');
    assert.deepEqual(capturasTenant, [42]);
  } finally { server.close(); }
});

test('preview: roda o SELECT e devolve amostra+total, sem materializar (sem INSERT)', async () => {
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('SELECT SEGMENTO FROM campanha')) {
        return { rows: [{ SEGMENTO: { sql: 'SELECT telefone, nome FROM dev', telefoneCol: 'telefone', variaveis: ['nome'] } }] };
      }
      if (sql.includes('SELECT COUNT(*) AS QTD')) return { rows: [{ QTD: 1200 }] };
      if (sql.includes('LIMIT :mczap_lim')) return { rows: [{ TELEFONE: '5562999990000', NOME: 'Fulano' }] };
      return { rows: [] };
    },
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await req(port, 'POST', '/api/campanhas/5/preview', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1200);
    assert.equal(r.body.custoEstimado, 1200 * 0.04);
    assert.equal(r.body.amostra[0].telefone, '5562999990000');
    assert.equal(capturas.some((c) => c.sql.startsWith('INSERT INTO campanha_item')), false);
  } finally { server.close(); }
});

test('preview: SEGMENTO já vem parseado (jsonb) — não faz JSON.parse duplo', async () => {
  const conn = {
    async execute(sql) {
      if (sql.includes('SELECT SEGMENTO FROM campanha')) {
        return { rows: [{ SEGMENTO: { sql: 'SELECT telefone FROM dev', telefoneCol: 'telefone', variaveis: [] } }] };
      }
      if (sql.includes('SELECT COUNT(*) AS QTD')) return { rows: [{ QTD: 1 }] };
      if (sql.includes('LIMIT :mczap_lim')) return { rows: [{ TELEFONE: '5562999990000' }] };
      return { rows: [] };
    },
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await req(port, 'POST', '/api/campanhas/5/preview', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
  } finally { server.close(); }
});

test('preparar: dedup por telefone (2 linhas mesmo número → 1 item)', async () => {
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('SELECT STATUS, SEGMENTO')) {
        return { rows: [{ STATUS: 'rascunho', SEGMENTO: { sql: 'SELECT telefone, nome FROM dev', telefoneCol: 'telefone', variaveis: ['nome'] } }] };
      }
      // rodarCompleto: duas linhas, mesmo telefone (com e sem 9)
      if (/^SELECT \* FROM \(SELECT telefone, nome FROM dev\) AS seg LIMIT :mczap_max$/.test(sql)) {
        return { rows: [
          { TELEFONE: '5562983423192', NOME: 'A' },
          { TELEFONE: '556283423192', NOME: 'A dup' },
        ] };
      }
      return { rows: [], rowsAffected: 1, outBinds: {} };
    },
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await req(port, 'POST', '/api/campanhas/5/preparar', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.inseridos, 1);  // as duas variantes do mesmo número = 1
    assert.equal(r.body.pulados, 1);
    const inserts = capturas.filter((c) => c.sql.startsWith('INSERT INTO campanha_item'));
    assert.equal(inserts.length, 1);
  } finally { server.close(); }
});

test('preparar: conflito de UNIQUE usa ON CONFLICT DO NOTHING — conta como duplicado SEM abortar a transação', async () => {
  // Regressão: um catch(23505) deixaria a transação ABORTADA (Postgres exige
  // ROLLBACK/savepoint após erro) — o UPDATE campanha/INSERT auditoria
  // seguintes, na MESMA transação, falhariam com 25P02. Com ON CONFLICT DO
  // NOTHING o INSERT só devolve rowsAffected=0 (já existia) e a transação
  // segue viva — é isso que este teste prova.
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('SELECT STATUS, SEGMENTO')) {
        return { rows: [{ STATUS: 'rascunho', SEGMENTO: { sql: 'SELECT telefone FROM dev', telefoneCol: 'telefone', variaveis: [] } }] };
      }
      if (/^SELECT \* FROM \(SELECT telefone FROM dev\) AS seg LIMIT :mczap_max$/.test(sql)) {
        return { rows: [{ TELEFONE: '5562983423192' }] };
      }
      if (sql.startsWith('INSERT INTO campanha_item')) {
        assert.match(sql, /ON CONFLICT ON CONSTRAINT uq_ci_camp_tel DO NOTHING/);
        return { rows: [], rowsAffected: 0 }; // conflito: item já existia, nada inserido
      }
      return { rows: [], rowsAffected: 1 };
    },
  };
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await req(port, 'POST', '/api/campanhas/5/preparar', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.inseridos, 0);
    assert.equal(r.body.duplicados, 1);
    // a transação continuou viva: UPDATE campanha e INSERT auditoria rodaram.
    assert.ok(capturas.some((c) => c.sql.startsWith('UPDATE campanha SET TOTAL')));
    assert.ok(capturas.some((c) => c.sql.startsWith('INSERT INTO auditoria')));
  } finally { server.close(); }
});
