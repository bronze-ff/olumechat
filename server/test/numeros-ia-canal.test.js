'use strict';
// FIL-84 — o ADMIN do cliente passa a ligar/desligar a IA no próprio canal.
//
// Até aqui TODO o PUT /api/numeros/:id era `exigirSuporteOperador`: só o
// operador, dentro de uma sessão de suporte auditada. Isso continua certo para
// phone_number_id, filial e limite diário — cadastro técnico do canal. Mas
// "ligar a IA neste número" é decisão de NEGÓCIO do cliente, e não pode
// depender de abrir chamado.
//
// A rota é SEPARADA de propósito: abrir o PUT inteiro para o ADMIN entregaria
// junto o phone_number_id e o resto do provisionamento.

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
const numerosRoutes = require('../api/numeros');

const TOKEN = jwt.sign({ jti: 'nc1', tenantId: 1, matricula: 123, nome: 'Ana' }, SECRET, { expiresIn: '1h' });

const ADMIN = { atendenteId: 42, papel: 'ADMIN', deptoIds: [], numeroIds: [], ativo: true };
const SUPERVISOR = { atendenteId: 43, papel: 'SUPERVISOR', deptoIds: [], numeroIds: [], ativo: true };

function startApp(conn, perfil) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/numeros', authMiddleware, (req, res, next) => { req.perfil = perfil; req.tenantId = 1; next(); }, numerosRoutes);
  app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
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

function fakeConn(rotas = [], capturas = []) {
  return {
    capturas,
    async execute(sql, binds = {}) {
      capturas.push({ sql, binds });
      for (const [re, resp] of rotas) {
        if (re.test(sql)) return typeof resp === 'function' ? resp(binds) : resp;
      }
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

const IA_LIGADA = [/SELECT ia_habilitada FROM tenant/i, { rows: [{ IA_HABILITADA: 'S' }] }];

test('ADMIN liga a IA no canal com regra de horário e modo teste', async () => {
  const capturas = [];
  const conn = fakeConn([IA_LIGADA, [/^UPDATE numero/i, { rowsAffected: 1 }]], capturas);
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await req(port, 'PUT', '/api/numeros/2/ia', { ativo: true, regra: 'fora_horario', modoTeste: false });
    assert.equal(r.status, 200);
  } finally { server.close(); }

  const upd = capturas.find((c) => /^UPDATE numero/i.test(c.sql));
  assert.equal(upd.binds.modo, 'ia');
  assert.equal(upd.binds.regra, 'fora_horario');
  assert.equal(upd.binds.teste, 'N');
  // A rota do ADMIN NÃO pode tocar em nada de provisionamento.
  for (const proibido of ['phone_number_id', 'codfilial', 'limite_diario', 'permite_ativo', 'nome_exibicao', 'departamento_padrao_id']) {
    assert.ok(!new RegExp(proibido, 'i').test(upd.sql),
      `a rota de IA do ADMIN não pode escrever em ${proibido}`);
  }
});

test('desligar a IA roda a cascata: conversa presa em fila_status=ia é liberada', async () => {
  const capturas = [];
  const conn = fakeConn([
    IA_LIGADA,
    [/^UPDATE numero/i, { rowsAffected: 1 }],
    [/FROM numero n/i, { rows: [{ DEP: 9, FLUXO_ID: null }] }],
    [/^UPDATE conversa/i, { rowsAffected: 3 }],
  ], capturas);
  const { server, port } = await startApp(conn, ADMIN);
  try {
    assert.equal((await req(port, 'PUT', '/api/numeros/2/ia', { ativo: false })).status, 200);
  } finally { server.close(); }

  const updConversa = capturas.find((c) => /^UPDATE conversa/i.test(c.sql));
  assert.ok(updConversa, 'sem a cascata, quem testou a IA fica preso no "canal restrito" para sempre');
  assert.match(updConversa.sql, /fila_status = 'ia'/i, 'a cascata só toca conversa que estava na IA');
  assert.equal(updConversa.binds.st, 'aguardando');
});

test('regra inválida é 400 (nunca chega ao banco)', async () => {
  const capturas = [];
  const conn = fakeConn([IA_LIGADA], capturas);
  const { server, port } = await startApp(conn, ADMIN);
  try {
    assert.equal((await req(port, 'PUT', '/api/numeros/2/ia', { regra: 'quando_der' })).status, 400);
  } finally { server.close(); }
  assert.ok(!capturas.some((c) => /^UPDATE numero/i.test(c.sql)));
});

test('corpo vazio é 400 (nada para atualizar)', async () => {
  const conn = fakeConn([IA_LIGADA]);
  const { server, port } = await startApp(conn, ADMIN);
  try {
    assert.equal((await req(port, 'PUT', '/api/numeros/2/ia', {})).status, 400);
  } finally { server.close(); }
});

test('SUPERVISOR não edita a IA do canal (só ADMIN)', async () => {
  const conn = fakeConn([IA_LIGADA]);
  const { server, port } = await startApp(conn, SUPERVISOR);
  try {
    assert.equal((await req(port, 'PUT', '/api/numeros/2/ia', { ativo: true })).status, 403);
  } finally { server.close(); }
});

test('add-on de IA desligado no plano: 400 antes de qualquer escrita', async () => {
  const capturas = [];
  const conn = fakeConn([[/SELECT ia_habilitada FROM tenant/i, { rows: [{ IA_HABILITADA: 'N' }] }]], capturas);
  const { server, port } = await startApp(conn, ADMIN);
  try {
    assert.equal((await req(port, 'PUT', '/api/numeros/2/ia', { ativo: true })).status, 400);
  } finally { server.close(); }
  assert.ok(!capturas.some((c) => /^UPDATE numero/i.test(c.sql)));
});

test('número inexistente é 404', async () => {
  const conn = fakeConn([IA_LIGADA, [/^UPDATE numero/i, { rowsAffected: 0 }]]);
  const { server, port } = await startApp(conn, ADMIN);
  try {
    assert.equal((await req(port, 'PUT', '/api/numeros/999/ia', { ativo: true })).status, 404);
  } finally { server.close(); }
});

test('SEGURANÇA: o UPDATE leva o tenant_id do JWT (defesa em profundidade sobre a RLS)', async () => {
  const capturas = [];
  const conn = fakeConn([IA_LIGADA, [/^UPDATE numero/i, { rowsAffected: 1 }]], capturas);
  const { server, port } = await startApp(conn, ADMIN);
  try {
    await req(port, 'PUT', '/api/numeros/2/ia', { modoTeste: true });
  } finally { server.close(); }
  const upd = capturas.find((c) => /^UPDATE numero/i.test(c.sql));
  assert.match(upd.sql, /tenant_id = :tenantId/);
  assert.equal(upd.binds.tenantId, 1);
});

test('GET /api/numeros devolve iaRegra e iaModoTeste (a tela precisa deles)', async () => {
  const conn = fakeConn([[/SELECT n\.id, n\.phone_number_id/i,
    { rows: [{ ID: 2, MODO: 'ia', IA_REGRA: 'fora_horario', IA_MODO_TESTE: 'S' }] }]]);
  const { server, port } = await startApp(conn, ADMIN);
  try {
    const r = await req(port, 'GET', '/api/numeros');
    assert.equal(r.status, 200);
    assert.equal(r.body[0].iaRegra, 'fora_horario');
    assert.equal(r.body[0].iaModoTeste, 'S');
  } finally { server.close(); }
});
