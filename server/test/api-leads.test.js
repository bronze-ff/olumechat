'use strict';
// api/leads.js — POST /api/leads (FIL-96): formulário público da landing.
//
// `db.getConnection` é substituído por um duble (mesmo padrão de
// operador-credencial-ia.test.js): comOperador() não passa por RLS de
// verdade aqui — quem prova o isolamento no Postgres real é a migração
// 025 (server/test/migracao-025-lead-comercial.test.js).
process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const db = require('../db/pool');

// Recarrega o módulo a cada chamada: o rate limiter vive num `const` do
// módulo, então requerer uma vez só compartilharia a mesma janela/contador
// entre testes (o teste de honeypot "gastaria" tentativas do teste de rate
// limit, por exemplo). Cada teste começa com um limiter zerado.
function freshLeadsRouter() {
  delete require.cache[require.resolve('../api/leads')];
  return require('../api/leads');
}

function conexao(inseridos, binds) {
  return {
    async execute(sql, params = {}) {
      if (/INSERT INTO lead_comercial/i.test(sql)) {
        inseridos.push(1);
        if (binds) binds.push(params);
        return { rows: [{ ID: inseridos.length, CRIADO_EM: new Date() }] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function startServer(inseridos, binds) {
  db.getConnection = async () => conexao(inseridos, binds);
  const app = express();
  app.use(express.json());
  app.use('/api/leads', freshLeadsRouter());
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path: '/api/leads', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const LEAD_VALIDO = { nome: 'Ana Martins', empresa: 'Clínica Horizonte', email: 'ana@horizonte.com', tamanhoEquipe: '1 a 5 pessoas', origem: 'utm_source=teste' };

test('POST /api/leads: dados válidos grava o lead e devolve 201', async () => {
  const inseridos = [];
  const { server, port } = await startServer(inseridos);
  try {
    const r = await post(port, LEAD_VALIDO);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(inseridos.length, 1);
  } finally { server.close(); }
});

// Achado [P1] da review do PR #42: um `origem` de campanha paga (utm +
// gclid/fbclid) passa fácil de 200 chars, e o lead que veio de anúncio pago
// era justamente o que se perdia — 400 ANTES do `limitar()` truncar, e o
// fallback de mailto do front só entra em ação em falha de rede, não em 400.
test('POST /api/leads: origem de rastreamento gigante é TRUNCADA, nunca rejeita o lead', async () => {
  const inseridos = [];
  const binds = [];
  const { server, port } = await startServer(inseridos, binds);
  try {
    const origemGigante = 'utm_source=google&utm_medium=cpc&utm_campaign=demo&gclid='.padEnd(400, 'x');
    const r = await post(port, { ...LEAD_VALIDO, origem: origemGigante });
    assert.equal(r.status, 201, 'metadado auxiliar não pode rejeitar um lead legítimo');
    assert.equal(inseridos.length, 1);
    assert.equal(binds[0].origem.length, 200, 'limitar() trunca para o tamanho da coluna');
  } finally { server.close(); }
});

test('POST /api/leads: nome/empresa ausentes → 400, nada gravado', async () => {
  const inseridos = [];
  const { server, port } = await startServer(inseridos);
  try {
    const r = await post(port, { email: 'ana@horizonte.com' });
    assert.equal(r.status, 400);
    assert.equal(inseridos.length, 0);
  } finally { server.close(); }
});

test('POST /api/leads: e-mail inválido → 400, nada gravado', async () => {
  const inseridos = [];
  const { server, port } = await startServer(inseridos);
  try {
    const r = await post(port, { ...LEAD_VALIDO, email: 'não-é-email' });
    assert.equal(r.status, 400);
    assert.equal(inseridos.length, 0);
  } finally { server.close(); }
});

test('POST /api/leads: honeypot preenchido → 200 e descarta em silêncio (bot não sabe que foi filtrado)', async () => {
  const inseridos = [];
  const { server, port } = await startServer(inseridos);
  try {
    const r = await post(port, { ...LEAD_VALIDO, site: 'http://spam.example' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(inseridos.length, 0, 'VAZAMENTO: honeypot preenchido não pode virar registro na tabela de leads');
  } finally { server.close(); }
});

test('POST /api/leads: honeypot vazio segue o fluxo normal (não filtra gente de verdade)', async () => {
  const inseridos = [];
  const { server, port } = await startServer(inseridos);
  try {
    const r = await post(port, { ...LEAD_VALIDO, site: '' });
    assert.equal(r.status, 201);
    assert.equal(inseridos.length, 1);
  } finally { server.close(); }
});

test('POST /api/leads: acima do rate limit por IP → 429', async () => {
  const inseridos = [];
  const { server, port } = await startServer(inseridos);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await post(port, LEAD_VALIDO);
      assert.equal(r.status, 201, `tentativa ${i + 1} ainda deveria passar`);
    }
    const limitada = await post(port, LEAD_VALIDO);
    assert.equal(limitada.status, 429);
  } finally { server.close(); }
});

test('POST /api/leads: falha do banco nunca vaza detalhe interno', async () => {
  db.getConnection = async () => ({
    async execute() { throw new Error('connection terminated: host=10.0.0.5 port=5432 detalhe-interno'); },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  });
  const app = express();
  app.use(express.json());
  app.use('/api/leads', freshLeadsRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;
  try {
    const r = await post(port, LEAD_VALIDO);
    assert.equal(r.status, 500);
    assert.ok(!/10\.0\.0\.5|connection terminated/i.test(JSON.stringify(r.body)), 'detalhe interno vazou pro cliente público');
  } finally { server.close(); }
});
