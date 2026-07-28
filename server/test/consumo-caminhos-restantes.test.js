// FIL-77 — 2ª rodada de review do Codex (P1): "o envio de template em
// conversa ativa (POST /api/conversas) e a despedida opcional
// (POST /:id/encerrar) persistem a mensagem mas não passam pelo registro de
// consumo." Prova que os dois caminhos agora gravam mensagem_enviada.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.DEV_META_FALLBACK = '1';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');

const TOKEN = jwt.sign({ jti: 'cr1', tenantId: 1, matricula: 123, nome: 'Teste', podeAtivo: true }, SECRET, { expiresIn: '1h' });

function startApp(conn, perfil) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => {
    req.tenantId = 1;
    if (perfil) req.perfil = perfil;
    next();
  }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}
function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` } },
      (res) => { let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') })); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

test('POST /api/conversas (template, conversa ativa): grava mensagem_enviada', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.T1' }] }) });
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM MC_ZAP_CONTATO') || sql.includes('FROM contato')) return { rows: [{ ID: 3, NOME_PERFIL: null }] };
      if (sql.includes('FROM auditoria')) return { rows: [] };
      if (sql.includes('FROM numero')) return { rows: [{ ID: 2, PHONE_NUMBER_ID: '1112223334', PERMITE_ATIVO: 'S', ATIVO: 'S' }] };
      if (sql.includes('FROM departamento')) return { rows: [] };
      if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260611100001' }] };
      if (sql.includes('FROM conversa')) return { rows: [] };
      if (sql.startsWith('INSERT INTO conversa')) return { outBinds: { id: [7] } };
      if (sql.startsWith('INSERT INTO mensagem')) return { outBinds: { id: [42] } };
      if (sql.includes('FROM atendente')) return { rows: [{ ID: 9 }] };
      return { rows: [], outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const { server, port } = await startApp(conn, { atendenteId: 9, papel: 'ADMIN', deptoIds: [], podeAtivo: true });
  try {
    const r = await post(port, '/api/conversas', { telefone: '5562999990000', templateName: 'lembrete_pagamento' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const evento = capturas.find((c) => /INSERT INTO consumo_evento/i.test(c.sql));
    assert.ok(evento, 'o template de conversa ativa deveria virar evento de consumo');
    assert.equal(evento.binds.tipo, 'mensagem_enviada');
    assert.equal(evento.binds.tenantId, 1);
  } finally { server.close(); }
});

test('POST /:id/encerrar (com despedida, janela aberta): grava mensagem_enviada', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.D1' }] }) });
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: 2, ATENDENTE_ID: null }] };
      }
      if (sql.includes('FROM conversa c')) {
        return {
          rows: [{
            CONTATO_ID: 3, NUMERO_ID: 2, DEPARTAMENTO_ID: null,
            JANELA_EXPIRA_EM: new Date(Date.now() + 60 * 60 * 1000),
            PROTOCOLO: 'P1', TELEFONE: '5562999990000', PHONE_NUMBER_ID: '1112223334',
          }],
        };
      }
      if (sql.includes('FROM atendente')) return { rows: [{ ID: 9, NOME: 'Ana' }] };
      return { rows: [], outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const { server, port } = await startApp(conn, { atendenteId: 9, papel: 'ADMIN', deptoIds: [] });
  try {
    const r = await post(port, '/api/conversas/7/encerrar', { despedida: 'Até mais!' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const evento = capturas.find((c) => /INSERT INTO consumo_evento/i.test(c.sql));
    assert.ok(evento, 'a despedida enviada deveria virar evento de consumo');
    assert.equal(evento.binds.tipo, 'mensagem_enviada');
    assert.equal(evento.binds.tenantId, 1);
  } finally { server.close(); }
});

test('POST /:id/encerrar (SEM despedida): não grava evento nenhum — nada foi enviado', async () => {
  const capturas = [];
  const conn = {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: 2, ATENDENTE_ID: null }] };
      }
      if (sql.includes('FROM conversa c')) {
        return {
          rows: [{
            CONTATO_ID: 3, NUMERO_ID: 2, DEPARTAMENTO_ID: null,
            JANELA_EXPIRA_EM: new Date(Date.now() + 60 * 60 * 1000),
            PROTOCOLO: 'P1', TELEFONE: '5562999990000', PHONE_NUMBER_ID: '1112223334',
          }],
        };
      }
      if (sql.includes('FROM atendente')) return { rows: [{ ID: 9, NOME: 'Ana' }] };
      return { rows: [], outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const { server, port } = await startApp(conn, { atendenteId: 9, papel: 'ADMIN', deptoIds: [] });
  try {
    const r = await post(port, '/api/conversas/7/encerrar', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(capturas.filter((c) => /INSERT INTO consumo_evento/i.test(c.sql)).length, 0);
  } finally { server.close(); }
});
