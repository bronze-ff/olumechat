// Teste do isolamento de tenant no SSE (api/stream.js): um evento publicado
// para o tenant A nunca pode chegar a um assinante do tenant B — mesmo que o
// perfil do assinante (papel ADMIN, sem departamento) faria podeReceber()
// aceitar o evento se o gate de tenant não existisse.
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
const presence = require('../realtime/presence');
const { publish } = require('../realtime/hub');
const streamRoutes = require('../api/stream');

const TOKEN = jwt.sign({ jti: 'tstream1', matricula: 999, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

// Simula o banco por trás de carregarPerfil (auth/rbac) + tenantDoAtendente
// (presence): atendente 42, tenant 1, sem departamento/número restrito.
function fakeConn() {
  return {
    async execute(sql) {
      if (sql.includes('FROM MC_ZAP_ATENDENTE WHERE MATRICULA')) {
        return { rows: [{ ID: 42, PAPEL: 'ADMIN', ATIVO: 'S', STATUS_PRESENCA: 'online', PODE_ATIVO: 'S' }] };
      }
      if (sql.includes('FROM MC_ZAP_ATENDENTE_DEPTO')) return { rows: [] };
      if (sql.includes('FROM MC_ZAP_ATENDENTE_NUMERO')) return { rows: [] };
      if (sql.includes('FROM atendente WHERE id')) return { rows: [{ TENANT_ID: 1 }] };
      return { rows: [], outBinds: {}, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function startApp() {
  db.getConnection = async () => fakeConn();
  const app = express();
  app.use('/api/stream', streamRoutes);
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function getTicket(port) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path: '/api/stream/ticket',
        headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve(JSON.parse(o).ticket)); }
    );
    r.on('error', reject); r.end();
  });
}

function aguardar(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('SSE: evento publicado para OUTRO tenant nunca chega ao assinante', async () => {
  presence._reset();
  const { server, port } = await startApp();
  try {
    const ticket = await getTicket(port);
    const recebido = [];

    const cliente = http.get({ hostname: '127.0.0.1', port, path: `/api/stream?ticket=${ticket}` }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => recebido.push(chunk));
    });
    cliente.on('error', () => {}); // destroy() no fim do teste pode gerar ECONNRESET — irrelevante aqui

    await aguardar(100); // handshake + presence.conectar

    // Sem departamento no evento (inbox geral) — podeReceber() sozinho deixaria
    // passar os dois; só o gate de tenant deve barrar o primeiro.
    publish({ tipo: 'atribuicao', tenantId: 2, conversaId: 111, atendenteId: 999, departamentoId: null });
    publish({ tipo: 'atribuicao', tenantId: 1, conversaId: 222, atendenteId: 999, departamentoId: null });

    await aguardar(100);
    cliente.destroy();

    const texto = recebido.join('');
    assert.equal(texto.includes('"conversaId":111'), false); // tenant errado — nunca chega
    assert.ok(texto.includes('"conversaId":222'));            // tenant certo — chega
  } finally {
    server.close();
  }
});

test('SSE: evento sem tenantId (publicador ainda não portado) é descartado (fail-closed)', async () => {
  presence._reset();
  const { server, port } = await startApp();
  try {
    const ticket = await getTicket(port);
    const recebido = [];

    const cliente = http.get({ hostname: '127.0.0.1', port, path: `/api/stream?ticket=${ticket}` }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => recebido.push(chunk));
    });
    cliente.on('error', () => {}); // destroy() no fim do teste pode gerar ECONNRESET — irrelevante aqui

    await aguardar(100);
    publish({ tipo: 'mensagem', conversaId: 333, departamentoId: null }); // sem tenantId
    await aguardar(100);
    cliente.destroy();

    assert.equal(recebido.join('').includes('"conversaId":333'), false);
  } finally {
    server.close();
  }
});
