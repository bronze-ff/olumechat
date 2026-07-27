// Testes dos endpoints de fila: atribuir, transferir, encerrar e escopo do GET.
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

const TOKEN = jwt.sign({ jti: 'tf1', tenantId: 1, matricula: 123, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

function startApp(conn, perfil) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.perfil = perfil; req.tenantId = 1; next(); }, conversasRoutes);
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

const PERFIL_ATD = { atendenteId: 9, papel: 'ATENDENTE', deptoIds: [4], ativo: true };

function fakeConn({ atribuiu = true, capturas = [] } = {}) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      // Guard de escopo (conversaNoEscopo): conversa no depto 4 (= deptoIds do perfil).
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 50, DEPARTAMENTO_ID: 4, NUMERO_ID: 2, ATENDENTE_ID: 9 }] };
      }
      if (sql.startsWith('UPDATE conversa') && sql.includes(`fila_status = 'aguardando'`) && sql.includes('atribuida_em')) {
        return { rowsAffected: atribuiu ? 1 : 0 };
      }
      if (sql.includes('SELECT departamento_id FROM conversa')) return { rows: [{ DEPARTAMENTO_ID: 4 }] };
      if (sql.includes('SELECT contato_id, departamento_id')) {
        return { rows: [{ CONTATO_ID: 3, DEPARTAMENTO_ID: 4, ATENDENTE_ID: 9, PROTOCOLO: null }] };
      }
      if (sql.includes('FROM departamento WHERE id')) return { rows: [{ NOME: 'T.I' }] };
      if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260610100099' }] };
      if (sql.includes('FROM atendente WHERE matricula')) return { rows: [{ ID: 9 }] };
      if (sql.includes('SELECT c.contato_id')) {
        return { rows: [{ CONTATO_ID: 3, NUMERO_ID: 2, DEPARTAMENTO_ID: 4, JANELA_EXPIRA_EM: null, PROTOCOLO: '260610100001', TELEFONE: '5562999990000', PHONE_NUMBER_ID: null }] };
      }
      return { rows: [], outBinds: { id: [1] }, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('atribuir: assume da fila (200) e audita', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn({ capturas }), PERFIL_ATD);
  try {
    const r = await req(port, 'POST', '/api/conversas/50/atribuir');
    assert.equal(r.status, 200);
    assert.equal(r.body.atendenteId, 9);
    assert.ok(capturas.some((c) => c.sql.includes('INSERT INTO auditoria')));
  } finally { server.close(); }
});

test('atribuir: corrida perdida → 409', async () => {
  const { server, port } = await startApp(fakeConn({ atribuiu: false }), PERFIL_ATD);
  try {
    const r = await req(port, 'POST', '/api/conversas/50/atribuir');
    assert.equal(r.status, 409);
  } finally { server.close(); }
});

test('atribuir a terceiro sem ser gestor → 403', async () => {
  const { server, port } = await startApp(fakeConn({}), PERFIL_ATD);
  try {
    const r = await req(port, 'POST', '/api/conversas/50/atribuir', { atendenteId: 77 });
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

const PERFIL_SUP = { atendenteId: 2, papel: 'SUPERVISOR', deptoIds: [4, 5], ativo: true };

test('transferir p/ departamento: volta pra fila com protocolo + nota interna', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn({ capturas }), PERFIL_SUP);
  try {
    const r = await req(port, 'POST', '/api/conversas/50/transferir', { departamentoId: 5 });
    assert.equal(r.status, 200);
    const upd = capturas.find((c) => c.sql.includes(`fila_status = 'aguardando'`) && c.sql.startsWith('UPDATE'));
    assert.ok(upd, 'deve voltar pra fila');
    assert.equal(upd.binds.prot, '260610100099'); // ganhou protocolo (não tinha)
    const nota = capturas.find((c) => c.sql.includes(`'nota'`));
    assert.match(nota.binds.txt, /Transferida para departamento T\.I/);
  } finally { server.close(); }
});

test('encerrar: seta resolvida nos dois status e publica', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn({ capturas }), PERFIL_ATD);
  try {
    const r = await req(port, 'POST', '/api/conversas/50/encerrar', {});
    assert.equal(r.status, 200);
    const upd = capturas.find((c) => c.sql.includes(`status = 'resolvida'`));
    assert.match(upd.sql, /fila_status = 'resolvida'/);
    assert.match(upd.sql, /resolvida_em = now\(\)/);
  } finally { server.close(); }
});

test('RBAC: ATENDENTE não transfere p/ departamento que não atende (403)', async () => {
  const { server, port } = await startApp(fakeConn({}), PERFIL_ATD); // deptoIds [4]
  try {
    const r = await req(port, 'POST', '/api/conversas/50/transferir', { departamentoId: 7 });
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

test('RBAC: AUDITOR (somente-leitura) é bloqueado nas mutações (403)', async () => {
  const PERFIL_AUD = { atendenteId: 8, papel: 'AUDITOR', deptoIds: [], ativo: true };
  const { server, port } = await startApp(fakeConn({}), PERFIL_AUD);
  try {
    for (const path of ['/api/conversas/50/encerrar', '/api/conversas/50/notas', '/api/conversas/50/transferir']) {
      const r = await req(port, 'POST', path, { texto: 'x', departamentoId: 4 });
      assert.equal(r.status, 403, `esperado 403 em ${path}`);
    }
  } finally { server.close(); }
});

test('IDOR: ATENDENTE recebe 404 ao agir em conversa FORA do seu escopo (outro depto/número)', async () => {
  // Conversa no depto 99 / número 5 / atribuída a outro (1234); perfil só vê depto 4.
  const conn = {
    async execute(sql) {
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 77, DEPARTAMENTO_ID: 99, NUMERO_ID: 5, ATENDENTE_ID: 1234 }] };
      }
      return { rows: [], rowsAffected: 1, outBinds: { id: [1] } };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    for (const path of ['/api/conversas/77/mensagens', '/api/conversas/77/encerrar', '/api/conversas/77/notas']) {
      const r = await req(port, path.endsWith('mensagens') ? 'GET' : 'POST', path, { texto: 'x' });
      assert.equal(r.status, 404, `esperado 404 em ${path}`);
    }
  } finally { server.close(); }
});

test('GET escopo: ATENDENTE gera filtro por deptos/atribuídas/sem-depto', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn({ capturas }), PERFIL_ATD);
  try {
    const r = await req(port, 'GET', '/api/conversas?fila=aguardando');
    assert.equal(r.status, 200);
    const sel = capturas.find((c) => c.sql.includes('FROM conversa c'));
    assert.match(sel.sql, /departamento_id IS NULL/);
    assert.match(sel.sql, /atendente_id = :escopoAtd/);
    assert.match(sel.sql, /departamento_id IN \(:escDep0\)/);
    assert.match(sel.sql, /fila_status = :fila/);
  } finally { server.close(); }
});

test('GET fila=ia: whitelist aceita a fila do bot de IA (aba "Bot (IA)")', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn({ capturas }), { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true });
  try {
    const r = await req(port, 'GET', '/api/conversas?fila=ia');
    assert.equal(r.status, 200);
    const sel = capturas.find((c) => c.sql.includes('FROM conversa c'));
    assert.match(sel.sql, /fila_status = :fila/);
    assert.equal(sel.binds.fila, 'ia');
  } finally { server.close(); }
});

test('GET escopo: ADMIN não recebe filtro de escopo', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn({ capturas }), { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true });
  try {
    await req(port, 'GET', '/api/conversas');
    const sel = capturas.find((c) => c.sql.includes('FROM conversa c'));
    assert.equal(/escopoAtd|escDep/.test(sel.sql), false);
  } finally { server.close(); }
});

test('Visibilidade exclusiva: ATENDENTE só vê do depto o que está SEM dono (guard atendente_id IS NULL)', async () => {
  const capturas = [];
  const { server, port } = await startApp(fakeConn({ capturas }), PERFIL_ATD);
  try {
    await req(port, 'GET', '/api/conversas');
    const sel = capturas.find((c) => c.sql.includes('FROM conversa c'));
    assert.match(sel.sql, /departamento_id IN \(:escDep0\) AND c\.atendente_id IS NULL/); // depto só sem dono
    assert.match(sel.sql, /c\.atendente_id = :escopoAtd/);                                 // + as atribuídas a ele
  } finally { server.close(); }
});

test('Visibilidade: SUPERVISOR vê o departamento inteiro (sem o guard de dono)', async () => {
  const capturas = [];
  const PERFIL_SUP = { atendenteId: 8, papel: 'SUPERVISOR', deptoIds: [4], ativo: true };
  const { server, port } = await startApp(fakeConn({ capturas }), PERFIL_SUP);
  try {
    await req(port, 'GET', '/api/conversas');
    const sel = capturas.find((c) => c.sql.includes('FROM conversa c'));
    assert.match(sel.sql, /departamento_id IN \(:escDep0\)/);
    assert.equal(/IN \(:escDep0\) AND c\.atendente_id IS NULL/.test(sel.sql), false); // não restringe por dono
  } finally { server.close(); }
});

test('Visibilidade exclusiva: ATENDENTE recebe 404 em conversa do SEU depto mas de OUTRO atendente', async () => {
  const conn = {
    async execute(sql) {
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 88, DEPARTAMENTO_ID: 4, NUMERO_ID: null, ATENDENTE_ID: 1234 }] }; // depto dele, dono é outro
      }
      return { rows: [], rowsAffected: 1, outBinds: { id: [1] } };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    const r = await req(port, 'GET', '/api/conversas/88/mensagens');
    assert.equal(r.status, 404);
  } finally { server.close(); }
});
