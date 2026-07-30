'use strict';
// operador/leads.js + rotas /api/operador/leads (FIL-96).
//
// Camada 1 — unidade: comOperador roda via db.getConnection (duble), mesmo
// padrão de operador-credencial-ia.test.js.
// Camada 2 — rota: prova o critério de aceite "um tenant logado não consegue
// ler leads" — um JWT de tenant (outro segredo) bate em operador/middleware.js
// e nunca chega ao SQL. Quem prova o RLS de verdade é a migração 025.
process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.APP_URL = 'https://painel.olume.test';
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const leads = require('../operador/leads');
const operadorRoutes = require('../operador/routes');
const { SECRET: SECRET_OPERADOR } = require('../operador/segredo');
const { SECRET: SECRET_TENANT } = require('../auth/secret');

const OPERADOR = { id: 1, email: 'op@olume.test', nome: 'Operador Teste' };

// ---------------------------------------------------------------------------
// (1) Unidade — operador/leads.js
// ---------------------------------------------------------------------------
function conexao({ leadsExistentes = [] } = {}) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      cap.push({ sql, binds });
      if (/^SELECT set_config/i.test(sql)) return { rows: [] };
      if (/INSERT INTO lead_comercial/i.test(sql)) {
        return { rows: [{ ID: 42, CRIADO_EM: new Date() }] };
      }
      if (/SELECT id, email, nome FROM operador WHERE id = :id/i.test(sql)) {
        return { rows: [{ ID: OPERADOR.id, EMAIL: OPERADOR.email, NOME: OPERADOR.nome }] };
      }
      if (/SELECT count\(\*\) AS novos FROM lead_comercial/i.test(sql)) {
        return { rows: [{ NOVOS: leadsExistentes.filter((l) => l.STATUS === 'novo').length }] };
      }
      if (/FROM lead_comercial\s*(WHERE status = :status)?\s*ORDER BY criado_em DESC/i.test(sql)) {
        const filtrados = binds.status ? leadsExistentes.filter((l) => l.STATUS === binds.status) : leadsExistentes;
        return { rows: filtrados };
      }
      if (/UPDATE lead_comercial\s+SET status/i.test(sql)) {
        const l = leadsExistentes.find((x) => x.ID === binds.id);
        if (!l) return { rows: [] };
        l.STATUS = binds.status;
        if (binds.observacao !== null && binds.observacao !== undefined) l.OBSERVACAO = binds.observacao;
        return { rows: [{ ...l }] };
      }
      if (/INSERT INTO operador_auditoria/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('criar: grava o lead público sem sessão de operador', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await leads.criar({ nome: 'Ana', empresa: 'Acme', email: 'ana@acme.com' });
  assert.ok(r.ID > 0);
  assert.ok(conn.cap.some((c) => /INSERT INTO lead_comercial/i.test(c.sql)));
});

test('listar: sem filtro devolve todos; com filtro, só o status pedido', async () => {
  const base = [
    { ID: 1, STATUS: 'novo', NOME: 'A' },
    { ID: 2, STATUS: 'contatado', NOME: 'B' },
  ];
  db.getConnection = async () => conexao({ leadsExistentes: base });
  const todos = await leads.listar();
  assert.equal(todos.length, 2);
  const novos = await leads.listar({ status: 'novo' });
  assert.equal(novos.length, 1);
  assert.equal(novos[0].NOME, 'A');
});

test('listar: status inválido é rejeitado ANTES de tocar o banco', async () => {
  await assert.rejects(
    leads.listar({ status: 'zzz' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('contarNovos: conta só status novo — é o número do badge', async () => {
  const base = [
    { ID: 1, STATUS: 'novo' }, { ID: 2, STATUS: 'novo' }, { ID: 3, STATUS: 'descartado' },
  ];
  db.getConnection = async () => conexao({ leadsExistentes: base });
  assert.equal(await leads.contarNovos(), 2);
});

test('atualizarStatus: marca contatado e AUDITA a ação (tenant_id nulo — não é ação de tenant)', async () => {
  const base = [{ ID: 5, STATUS: 'novo', OBSERVACAO: null }];
  const conn = conexao({ leadsExistentes: base });
  db.getConnection = async () => conn;
  const r = await leads.atualizarStatus({ operador: OPERADOR, id: 5, status: 'contatado', ip: '1.2.3.4' });
  assert.equal(r.STATUS, 'contatado');
  const auditado = conn.cap.find((c) => /INSERT INTO operador_auditoria/i.test(c.sql));
  assert.ok(auditado, 'toda ação de operador tem que gerar trilha');
  assert.equal(auditado.binds.tenantId, null, 'lead não é de tenant nenhum');
});

test('atualizarStatus: sem `observacao` no PATCH mantém a nota já gravada (não upserta o registro inteiro)', async () => {
  const base = [{ ID: 6, STATUS: 'novo', OBSERVACAO: 'nota original' }];
  db.getConnection = async () => conexao({ leadsExistentes: base });
  const r = await leads.atualizarStatus({ operador: OPERADOR, id: 6, status: 'descartado' });
  assert.equal(r.OBSERVACAO, 'nota original');
});

test('atualizarStatus: id inexistente → 404 de negócio', async () => {
  db.getConnection = async () => conexao({ leadsExistentes: [] });
  await assert.rejects(
    leads.atualizarStatus({ operador: OPERADOR, id: 999, status: 'contatado' }),
    (err) => err.deOperador && err.status === 404
  );
});

test('atualizarStatus: status inválido → 400 de negócio, sem tocar o banco', async () => {
  await assert.rejects(
    leads.atualizarStatus({ operador: OPERADOR, id: 1, status: 'arquivado' }),
    (err) => err.deOperador && err.status === 400
  );
});

// ---------------------------------------------------------------------------
// (2) Rota — isolamento de sessão em /api/operador/leads
// ---------------------------------------------------------------------------
function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/operador', operadorRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function get(port, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', hostname: '127.0.0.1', port, path, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null })); }
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/operador/leads sem token → 401', async () => {
  const { server, port } = await startApp();
  try {
    const r = await get(port, '/api/operador/leads');
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

test('GET /api/operador/leads com JWT de TENANT → 403 (nunca alcança o SQL de leads)', async () => {
  const { server, port } = await startApp();
  try {
    const tokenDeTenant = jwt.sign({ tenantId: 10, usuarioId: 1, matricula: 1 }, SECRET_TENANT, { expiresIn: '1h' });
    const r = await get(port, '/api/operador/leads', tokenDeTenant);
    assert.equal(r.status, 403, 'um ADMIN de tenant não pode ler a carteira de leads da Olume');
  } finally { server.close(); }
});

test('GET /api/operador/leads com sessão de operador válida → 200 com a listagem', async () => {
  const base = [{ ID: 1, NOME: 'Ana', EMPRESA: 'Acme', EMAIL: 'ana@acme.com', STATUS: 'novo', TAMANHO_EQUIPE: null, ORIGEM: null, OBSERVACAO: null, CRIADO_EM: new Date(), ATUALIZADO_EM: new Date() }];
  db.getConnection = async () => conexao({ leadsExistentes: base });
  const { server, port } = await startApp();
  try {
    const tokenDeOperador = jwt.sign({ escopo: 'operador', operadorId: OPERADOR.id, email: OPERADOR.email }, SECRET_OPERADOR, { expiresIn: '1h' });
    const r = await get(port, '/api/operador/leads', tokenDeOperador);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].nome, 'Ana');
  } finally { server.close(); }
});
