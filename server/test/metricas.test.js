// Testes de métricas/histórico: escopo do supervisor, paginação e CSV.
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

const TOKEN = jwt.sign({ jti: 'tm1', matricula: 123, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

function startApp(rotas, conn, perfil) {
  db.getConnection = async () => conn;
  db.comTenant = async (tenantId, fn) => fn(conn); // rotas de metricas/historico passam por comTenant()
  const app = express();
  app.use('/api', express.json());
  for (const [caminho, router] of rotas) {
    app.use(caminho, authMiddleware, (req, res, next) => { req.perfil = perfil; req.tenantId = perfil.tenantId; next(); }, router);
  }
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path, headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: o })); }
    ).on('error', reject);
  });
}

function fakeConn(capturas = []) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('COUNT(*) AS QTD')) return { rows: [{ QTD: 2 }] };
      if (sql.includes('AS TOTAL')) return { rows: [{ TOTAL: 5, RESOLVIDAS: 3 }] };
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('metricas: SUPERVISOR é escopado aos seus departamentos', async () => {
  const capturas = [];
  const { server, port } = await startApp(
    [['/api/metricas', require('../api/metricas')]],
    fakeConn(capturas),
    { atendenteId: 1, papel: 'SUPERVISOR', deptoIds: [2, 3], ativo: true, tenantId: 1 }
  );
  try {
    const r = await get(port, '/api/metricas/resumo');
    assert.equal(r.status, 200);
    const sel = capturas.find((c) => c.sql.includes('AS TOTAL'));
    assert.match(sel.sql, /c\.tenant_id = :tenantId/);
    assert.match(sel.sql, /departamento_id IN \(:sd0,:sd1\)/);
  } finally { server.close(); }
});

test('metricas: AUDITOR vê tudo (sem escopo)', async () => {
  const capturas = [];
  const { server, port } = await startApp(
    [['/api/metricas', require('../api/metricas')]],
    fakeConn(capturas),
    { atendenteId: 1, papel: 'AUDITOR', deptoIds: [], ativo: true, tenantId: 1 }
  );
  try {
    const r = await get(port, '/api/metricas/resumo?de=2026-06-01&ate=2026-06-10');
    assert.equal(r.status, 200);
    const sel = capturas.find((c) => c.sql.includes('AS TOTAL'));
    assert.equal(/IN \(:sd/.test(sel.sql), false);
    assert.match(sel.sql, /c\.criado_em >= :de::date/);
  } finally { server.close(); }
});

test('metricas: ATENDENTE não acessa (403)', async () => {
  const { server, port } = await startApp(
    [['/api/metricas', require('../api/metricas')]],
    fakeConn(),
    { atendenteId: 1, papel: 'ATENDENTE', deptoIds: [1], ativo: true, tenantId: 1 }
  );
  try {
    const r = await get(port, '/api/metricas/resumo');
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

test('historico: pagina com OFFSET/FETCH e devolve total', async () => {
  const capturas = [];
  const { server, port } = await startApp(
    [['/api/historico', require('../api/historico')]],
    fakeConn(capturas),
    { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true, tenantId: 1 }
  );
  try {
    const r = await get(port, '/api/historico?pagina=3&protocolo=260610100042');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.total, 2);
    assert.equal(body.pagina, 3);
    const sel = capturas.find((c) => c.sql.includes('OFFSET'));
    assert.equal(sel.binds.off, 50); // (3-1) * 25
    assert.equal(sel.binds.prot, '260610100042');
  } finally { server.close(); }
});

test('historico: export CSV audita e manda BOM + cabeçalho', async () => {
  const capturas = [];
  const { server, port } = await startApp(
    [['/api/historico', require('../api/historico')]],
    fakeConn(capturas),
    { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true, tenantId: 1 }
  );
  try {
    const r = await get(port, '/api/historico/export.csv');
    assert.equal(r.status, 200);
    assert.equal(r.body.charCodeAt(0), 0xFEFF);
    assert.match(r.body, /Protocolo;Status;Origem;Cliente/);
    assert.ok(capturas.some((c) => c.sql.includes(`'export_csv'`)));
  } finally { server.close(); }
});

test('config: GET devolve mapa e PUT (ADMIN) faz upsert auditado', async () => {
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('SELECT CHAVE, VALOR')) {
        return { rows: [{ CHAVE: 'despedida_padrao', VALOR: 'Tchau {{protocolo}}' }] };
      }
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const { server, port } = await startApp(
    [['/api/config', require('../api/config')]],
    conn,
    { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true }
  );
  try {
    const g = await get(port, '/api/config');
    assert.equal(JSON.parse(g.body).despedida_padrao, 'Tchau {{protocolo}}');

    const body = JSON.stringify({ despedida_padrao: 'Novo texto', chave_invasora: 'x' });
    const r = await new Promise((resolve, reject) => {
      const rq = http.request(
        { method: 'PUT', hostname: '127.0.0.1', port, path: '/api/config',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${TOKEN}` } },
        (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode })); }
      );
      rq.on('error', reject); rq.write(body); rq.end();
    });
    assert.equal(r.status, 200);
    const merges = capturas.filter((c) => c.sql.startsWith('MERGE INTO MC_ZAP_CONFIG'));
    assert.equal(merges.length, 1); // chave fora da whitelist NÃO gravou
    assert.equal(merges[0].binds.v, 'Novo texto');
    assert.ok(capturas.some((c) => c.sql.includes(`'config_update'`)));
  } finally { server.close(); }
});

test('fluxos: PUT atualiza DEFINICAO por atribuição direta (sem COALESCE no CLOB)', async () => {
  const capturas = [];
  const { server, port } = await startApp(
    [['/api/fluxos', require('../api/fluxos')]],
    fakeConn(capturas),
    { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true }
  );
  try {
    const body = JSON.stringify({
      nome: 'menu principal',
      numeroId: 2,
      definicao: {
        config: { inicio: 'a' },
        nos: [{ id: 'a', tipo: 'encerrar', texto: 'fim' }],
      },
    });
    const r = await new Promise((resolve, reject) => {
      const rq = http.request(
        { method: 'PUT', hostname: '127.0.0.1', port, path: '/api/fluxos/1',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${TOKEN}` } },
        (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: o })); }
      );
      rq.on('error', reject); rq.write(body); rq.end();
    });
    assert.equal(r.status, 200);
    const upd = capturas.find((c) => c.sql.startsWith('UPDATE MC_ZAP_FLUXO'));
    assert.ok(upd, 'deve executar o UPDATE');
    // ORA-00932: bind VARCHAR2 dentro de COALESCE com coluna CLOB — proibido.
    assert.equal(/COALESCE\([^)]*:def/i.test(upd.sql), false);
    assert.match(upd.sql, /DEFINICAO = :def/);
    assert.match(upd.binds.def, /menu|encerrar/);
    assert.equal(upd.binds.num, 2);
  } finally { server.close(); }
});

test('fluxos: simulador valida e responde a saudação', async () => {
  const { server, port } = await startApp(
    [['/api/fluxos', require('../api/fluxos')]],
    fakeConn(),
    { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true }
  );
  try {
    const body = JSON.stringify({
      definicao: {
        config: { inicio: 'a' },
        nos: [
          { id: 'a', tipo: 'mensagem', texto: 'Oi {{nome}}', proximo: 'b' },
          { id: 'b', tipo: 'encerrar', texto: 'Tchau' },
        ],
      },
    });
    const r = await new Promise((resolve, reject) => {
      const rq = http.request(
        { method: 'POST', hostname: '127.0.0.1', port, path: '/api/fluxos/simular',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${TOKEN}` } },
        (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o) })); }
      );
      rq.on('error', reject); rq.write(body); rq.end();
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.mensagens[0], 'Oi Cliente Teste');
    assert.deepEqual(r.body.acao, { tipo: 'encerrar' });
  } finally { server.close(); }
});
