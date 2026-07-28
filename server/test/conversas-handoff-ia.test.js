'use strict';
// FIL-84 — handoff nos dois sentidos, pelo lado do atendente.
//
// Antes deste ticket, 'aguardando'/'em_atendimento' → 'ia' NÃO EXISTIA em lugar
// nenhum do código, e sair da IA só acontecia por acidente (o /transferir sem
// guarda de fila_status, ou o operador virando o número inteiro para modo
// padrão). Estas duas rotas são as transições projetadas.

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

const TOKEN = jwt.sign({ jti: 'hf1', tenantId: 1, matricula: 123, nome: 'Ana' }, SECRET, { expiresIn: '1h' });

const PERFIL_ATD = { atendenteId: 42, papel: 'ATENDENTE', deptoIds: [9], numeroIds: [], ativo: true };
const PERFIL_AUDITOR = { atendenteId: 7, papel: 'AUDITOR', deptoIds: [], numeroIds: [], ativo: true };

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

/** Conexão falsa por regex, guardando tudo que executou. */
function fakeConn(rotas = [], capturas = []) {
  return {
    capturas,
    async execute(sql, binds = {}) {
      capturas.push({ sql, binds });
      for (const [re, resp] of rotas) {
        if (re.test(sql)) return typeof resp === 'function' ? resp(binds) : resp;
      }
      return { rows: [], rowsAffected: 1, outBinds: { id: [1] } };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

// conversaNoEscopo: conversa da IA (sem depto, sem dono) — visível ao atendente.
const ESCOPO_IA = [/SELECT id, departamento_id, numero_id, atendente_id/i,
  { rows: [{ ID: 88, DEPARTAMENTO_ID: null, NUMERO_ID: 2, ATENDENTE_ID: null }] }];
// conversaNoEscopo: conversa já em atendimento pelo próprio atendente.
const ESCOPO_MINHA = [/SELECT id, departamento_id, numero_id, atendente_id/i,
  { rows: [{ ID: 88, DEPARTAMENTO_ID: 9, NUMERO_ID: 2, ATENDENTE_ID: 42 }] }];
const ATENDENTE = [/FROM atendente WHERE matricula/i, { rows: [{ ID: 42 }] }];

test('assumir-ia: conversa da IA vira em_atendimento COM dono (quem clicou)', async () => {
  const capturas = [];
  const conn = fakeConn([
    ESCOPO_IA, ATENDENTE,
    [/SELECT fila_status, contato_id, numero_id, protocolo FROM conversa/i,
      { rows: [{ FILA_STATUS: 'ia', CONTATO_ID: 3, NUMERO_ID: 2, PROTOCOLO: 'P1' }] }],
    [/FROM numero n/i, { rows: [{ DEP: 9, FLUXO_ID: 4 }] }],
    [/^UPDATE conversa/i, { rowsAffected: 1 }],
  ], capturas);
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    const r = await req(port, 'POST', '/api/conversas/88/assumir-ia');
    assert.equal(r.status, 200);
    assert.equal(r.body.atendenteId, 42);
  } finally { server.close(); }

  const upd = capturas.find((c) => /^UPDATE conversa/i.test(c.sql));
  assert.match(upd.sql, /fila_status = 'em_atendimento'/i,
    'quem clica em Assumir vira DONO — nunca devolve a conversa para a fila');
  assert.match(upd.sql, /AND fila_status = 'ia'/i, 'guarda de corrida obrigatória');
  assert.ok(!/'bot'/.test(upd.sql), 'Assumir nunca joga o cliente de volta no bot de fluxo');
  assert.equal(upd.binds.atd, 42);
  assert.equal(upd.binds.dep, 9, 'o departamento vem da cascata compartilhada');
});

test('assumir-ia: conversa que já não está na IA responde 409 (corrida entre dois atendentes)', async () => {
  const capturas = [];
  const conn = fakeConn([
    ESCOPO_IA,
    [/SELECT fila_status, contato_id, numero_id, protocolo FROM conversa/i,
      { rows: [{ FILA_STATUS: 'em_atendimento', CONTATO_ID: 3, NUMERO_ID: 2, PROTOCOLO: 'P1' }] }],
  ], capturas);
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    const r = await req(port, 'POST', '/api/conversas/88/assumir-ia');
    assert.equal(r.status, 409);
  } finally { server.close(); }
  assert.ok(!capturas.some((c) => /^UPDATE conversa/i.test(c.sql)), 'não pode escrever nada');
});

test('assumir-ia: UPDATE que não afeta linha (corrida na janela do SELECT) também é 409', async () => {
  const conn = fakeConn([
    ESCOPO_IA, ATENDENTE,
    [/SELECT fila_status, contato_id, numero_id, protocolo FROM conversa/i,
      { rows: [{ FILA_STATUS: 'ia', CONTATO_ID: 3, NUMERO_ID: 2, PROTOCOLO: 'P1' }] }],
    [/FROM numero n/i, { rows: [{ DEP: null, FLUXO_ID: null }] }],
    [/^UPDATE conversa/i, { rowsAffected: 0 }],
  ]);
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    assert.equal((await req(port, 'POST', '/api/conversas/88/assumir-ia')).status, 409);
  } finally { server.close(); }
});

test('devolver-ia: limpa o estado de fila e deixa nota de sistema', async () => {
  const capturas = [];
  const conn = fakeConn([
    ESCOPO_MINHA, ATENDENTE,
    [/SELECT c\.fila_status, c\.contato_id, c\.departamento_id, n\.modo/i,
      { rows: [{ FILA_STATUS: 'em_atendimento', CONTATO_ID: 3, DEPARTAMENTO_ID: 9, MODO: 'ia' }] }],
    [/^UPDATE conversa/i, { rowsAffected: 1 }],
  ], capturas);
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    assert.equal((await req(port, 'POST', '/api/conversas/88/devolver-ia')).status, 200);
  } finally { server.close(); }

  const upd = capturas.find((c) => /^UPDATE conversa/i.test(c.sql));
  assert.match(upd.sql, /fila_status = 'ia'/i);
  assert.match(upd.sql, /departamento_id = NULL/i);
  assert.match(upd.sql, /atendente_id = NULL/i);
  const nota = capturas.find((c) => /INSERT INTO mensagem/i.test(c.sql));
  assert.match(nota.sql, /'nota'/);
  // Devolver para a IA é EVENTO do atendimento, não fala de atendente — por
  // isso a nota nasce com origem 'sistema' na timeline.
  assert.match(nota.sql, /'sistema'/);
});

test('devolver-ia num canal SEM IA ligada é 400 (a conversa ficaria presa sem ninguém)', async () => {
  const capturas = [];
  const conn = fakeConn([
    ESCOPO_MINHA,
    [/SELECT c\.fila_status, c\.contato_id, c\.departamento_id, n\.modo/i,
      { rows: [{ FILA_STATUS: 'em_atendimento', CONTATO_ID: 3, DEPARTAMENTO_ID: 9, MODO: 'padrao' }] }],
  ], capturas);
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    assert.equal((await req(port, 'POST', '/api/conversas/88/devolver-ia')).status, 400);
  } finally { server.close(); }
  assert.ok(!capturas.some((c) => /^UPDATE conversa/i.test(c.sql)));
});

test('devolver-ia numa conversa que não está com humano é 409', async () => {
  const conn = fakeConn([
    ESCOPO_MINHA, ATENDENTE,
    [/SELECT c\.fila_status, c\.contato_id, c\.departamento_id, n\.modo/i,
      { rows: [{ FILA_STATUS: 'resolvida', CONTATO_ID: 3, DEPARTAMENTO_ID: 9, MODO: 'ia' }] }],
    [/^UPDATE conversa/i, { rowsAffected: 0 }],
  ]);
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    assert.equal((await req(port, 'POST', '/api/conversas/88/devolver-ia')).status, 409);
  } finally { server.close(); }
});

test('AUDITOR (perfil somente-leitura) não assume nem devolve', async () => {
  const conn = fakeConn([ESCOPO_IA]);
  const { server, port } = await startApp(conn, PERFIL_AUDITOR);
  try {
    assert.equal((await req(port, 'POST', '/api/conversas/88/assumir-ia')).status, 403);
    assert.equal((await req(port, 'POST', '/api/conversas/88/devolver-ia')).status, 403);
  } finally { server.close(); }
});

test('IDOR: conversa fora do escopo do atendente responde 404 nas duas rotas', async () => {
  // Conversa de OUTRO departamento, já atribuída a um colega.
  const conn = fakeConn([
    [/SELECT id, departamento_id, numero_id, atendente_id/i,
      { rows: [{ ID: 88, DEPARTAMENTO_ID: 77, NUMERO_ID: 2, ATENDENTE_ID: 999 }] }],
  ]);
  const { server, port } = await startApp(conn, PERFIL_ATD);
  try {
    assert.equal((await req(port, 'POST', '/api/conversas/88/assumir-ia')).status, 404);
    assert.equal((await req(port, 'POST', '/api/conversas/88/devolver-ia')).status, 404);
  } finally { server.close(); }
});

test('a listagem devolve numeroModo (a UI só oferece "Devolver" em canal com IA)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'api', 'conversas.js'), 'utf8');
  assert.match(fonte, /n\.modo AS numero_modo/,
    'sem isto o front não sabe se o canal tem IA e o botão Devolver some ou aparece errado');
});
