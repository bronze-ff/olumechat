// Testes do INICIAR conversa (POST /api/conversas) — cobrança ativa via template.
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

function fakeConn({ optout = false, numero = { ID: 2 }, depExiste = true, capture = {} } = {}) {
  return {
    async execute(sql, binds) {
      if (sql.includes('FROM MC_ZAP_CONTATO')) return { rows: [{ ID: 3, NOME_PERFIL: null }] };
      if (sql.includes('FROM auditoria')) return { rows: optout ? [{ ACAO: 'optout' }] : [] };
      if (sql.includes('FROM numero')) return { rows: numero ? [numero] : [] };
      if (sql.includes('FROM departamento')) return { rows: depExiste ? [{ ID: binds && binds.id }] : [] };
      if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260611100001' }] };
      if (sql.includes('FROM conversa')) return { rows: [] };
      if (sql.startsWith('INSERT INTO conversa')) { capture.insert = binds; return { outBinds: { id: [7] } }; }
      if (sql.startsWith('INSERT INTO mensagem')) return { outBinds: { id: [42] } };
      if (sql.includes('FROM atendente')) return { rows: [{ ID: 9 }] };
      return { rows: [], outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function startApp(conn, perfil = { atendenteId: 9, papel: 'ADMIN', deptoIds: [], podeAtivo: true }) {
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

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path: '/api/conversas',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

test('iniciar: envia template e cria conversa (201)', async () => {
  let captured;
  global.fetch = async (url, opts) => { captured = JSON.parse(opts.body); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.T1' }] }) }; };
  const { server, port } = await startApp(fakeConn());
  try {
    const r = await post(port, { telefone: '62 99999-0000', templateName: 'lembrete_pagamento', variaveis: ['Fulano', '150,00', '10/06'] });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, 7);
    assert.equal(captured.type, 'template');
    assert.equal(captured.template.name, 'lembrete_pagamento');
    assert.equal(captured.to, '5562999990000'); // DDI 55 adicionado
  } finally { server.close(); }
});

test('iniciar: opt-out → 409 e NÃO chama a Graph API', async () => {
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const { server, port } = await startApp(fakeConn({ optout: true }));
  try {
    const r = await post(port, { telefone: '5562999990000', templateName: 'lembrete_pagamento' });
    assert.equal(r.status, 409);
    assert.equal(called, false);
  } finally { server.close(); }
});

test('iniciar: sem template → 400', async () => {
  const { server, port } = await startApp(fakeConn());
  try {
    const r = await post(port, { telefone: '5562999990000' });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});

test('iniciar: SEM permissão (podeAtivo=false) → 403', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  const { server, port } = await startApp(fakeConn(), { atendenteId: 5, papel: 'ATENDENTE', deptoIds: [], podeAtivo: false });
  try {
    const r = await post(port, { telefone: '5562999990000', templateName: 'lembrete_pagamento' });
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

test('iniciar: número com PERMITE_ATIVO=N → 409 e NÃO chama a Graph API', async () => {
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const { server, port } = await startApp(fakeConn({ numero: { ID: 2, PHONE_NUMBER_ID: '111', PERMITE_ATIVO: 'N', ATIVO: 'S' } }));
  try {
    const r = await post(port, { telefone: '5562999990000', templateName: 'lembrete_pagamento', numeroId: 2 });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /não permite conversa ativa/);
    assert.equal(called, false);
  } finally { server.close(); }
});

test('iniciar: numeroId escolhido envia pelo PHONE_NUMBER_ID daquele número', async () => {
  let urlChamada;
  global.fetch = async (url) => { urlChamada = String(url); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.T2' }] }) }; };
  const { server, port } = await startApp(fakeConn({ numero: { ID: 5, PHONE_NUMBER_ID: '5556667778', PERMITE_ATIVO: 'S', ATIVO: 'S' } }));
  try {
    const r = await post(port, { telefone: '5562999990000', templateName: 'lembrete_pagamento', numeroId: 5 });
    assert.equal(r.status, 201);
    assert.ok(urlChamada.includes('/5556667778/messages')); // saiu pelo número escolhido
  } finally { server.close(); }
});

test('iniciar: número com departamento padrão → conversa nasce nesse depto (não no Geral)', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.D1' }] }) });
  const capture = {};
  const conn = fakeConn({ numero: { ID: 2, PHONE_NUMBER_ID: '111', PERMITE_ATIVO: 'S', ATIVO: 'S', DEPARTAMENTO_PADRAO_ID: 4 }, capture });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port, { telefone: '5562999990000', templateName: 'lembrete_pagamento', numeroId: 2 });
    assert.equal(r.status, 201);
    assert.equal(capture.insert.dep, 4); // gravou o departamento padrão do número
    assert.equal(r.body.departamentoId, 4);
  } finally { server.close(); }
});

test('iniciar: número SEM padrão + departamentoId do modal → grava o escolhido', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.D2' }] }) });
  const capture = {};
  const conn = fakeConn({ numero: { ID: 2, PHONE_NUMBER_ID: '111', PERMITE_ATIVO: 'S', ATIVO: 'S', DEPARTAMENTO_PADRAO_ID: null }, capture });
  const { server, port } = await startApp(conn); // perfil ADMIN
  try {
    const r = await post(port, { telefone: '5562999990000', templateName: 'lembrete_pagamento', numeroId: 2, departamentoId: 6 });
    assert.equal(r.status, 201);
    assert.equal(capture.insert.dep, 6);
  } finally { server.close(); }
});

test('iniciar: departamentoId fora do escopo do atendente → 403 (não envia)', async () => {
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const conn = fakeConn({ numero: { ID: 2, PHONE_NUMBER_ID: '111', PERMITE_ATIVO: 'S', ATIVO: 'S', DEPARTAMENTO_PADRAO_ID: null } });
  const { server, port } = await startApp(conn, { atendenteId: 9, papel: 'ATENDENTE', deptoIds: [5], podeAtivo: true });
  try {
    const r = await post(port, { telefone: '5562999990000', templateName: 'lembrete_pagamento', numeroId: 2, departamentoId: 4 });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /não tem acesso a esse departamento/);
    assert.equal(called, false);
  } finally { server.close(); }
});
