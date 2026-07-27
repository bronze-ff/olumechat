// Teste de isolamento de tenant do CRUD de fluxos (critério de aceite do
// FIL-62). db-tenant.test.js já prova a RLS em si (contrato + integração real
// contra Postgres); este teste prova que api/fluxos.js NUNCA esquece de
// escopar por tenant_id — um "Postgres de mentira" para a tabela `fluxo`
// filtra exatamente como a policy isolamento_tenant filtraria de verdade.
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
const fluxosRoutes = require('../api/fluxos');

const TOKEN = jwt.sign({ jti: 'tf-tenant', matricula: 1, nome: 'Adm' }, SECRET, { expiresIn: '1h' });
const ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [] };

// `ctxTenant` simula o set_config('app.current_tenant_id', ..., true) do
// comTenant() real: é ELE (não o bind de cada query) que a RLS de verdade usa
// para filtrar — por isso o fake também deriva o filtro do contexto da
// "transação" corrente, setado por SET LOCAL ROLE/set_config a cada request.
function criarBancoFalso() {
  let nextId = 1;
  let ctxTenant = null;
  const linhas = [];
  return {
    async execute(sql, binds = {}) {
      if (/set_config/i.test(sql)) { ctxTenant = binds.tid; return { rows: [{ set_config: binds.tid }] }; }
      if (/^SET LOCAL ROLE/i.test(sql)) return { rows: [] };
      if (/^INSERT INTO fluxo/.test(sql)) {
        const id = nextId++;
        linhas.push({
          ID: id, TENANT_ID: ctxTenant, NOME: binds.n,
          NUMERO_ID: binds.num ?? null, DEFINICAO: JSON.parse(binds.def),
          ATIVO: 'N', VERSAO: 1,
        });
        return { outBinds: { id: [id] } };
      }
      if (/^SELECT id, nome, numero_id, ativo, versao, definicao FROM fluxo/.test(sql)) {
        const row = linhas.find((l) => l.ID === binds.id && String(l.TENANT_ID) === String(ctxTenant));
        return { rows: row ? [row] : [] };
      }
      if (/^SELECT f\.id, f\.nome/.test(sql)) {
        const doTenant = linhas.filter((l) => String(l.TENANT_ID) === String(ctxTenant));
        return { rows: doTenant.map((l) => ({ ID: l.ID, NOME: l.NOME, NUMERO_ID: l.NUMERO_ID, ATIVO: l.ATIVO, VERSAO: l.VERSAO })) };
      }
      if (/^UPDATE fluxo SET/.test(sql)) {
        const row = linhas.find((l) => l.ID === binds.id && String(l.TENANT_ID) === String(ctxTenant));
        if (!row) return { rowsAffected: 0 };
        if (binds.n !== undefined) row.NOME = binds.n;
        if ('num' in binds) row.NUMERO_ID = binds.num;
        if (binds.def !== undefined) row.DEFINICAO = JSON.parse(binds.def);
        row.VERSAO += 1;
        return { rowsAffected: 1 };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
    _linhas: linhas,
  };
}

function startApp(conn, tenantId) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/fluxos', authMiddleware, (req, res, next) => {
    req.perfil = ADMIN;
    req.tenantId = tenantId;
    next();
  }, fluxosRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, port: s.address().port })); });
}

function req(method, port, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      method, hostname: '127.0.0.1', port, path,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let o = ''; res.on('data', (c) => (o += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('fluxo do tenant A não é carregado nem editável pelo tenant B', async () => {
  const conn = criarBancoFalso();
  const DEF = { config: { inicio: 'x' }, nos: [{ id: 'x', tipo: 'encerrar', texto: 'fim' }] };

  const appA = await startApp(conn, 1);
  let id;
  try {
    const criado = await req('POST', appA.port, '/api/fluxos', { nome: 'Fluxo do A', definicao: DEF });
    assert.equal(criado.status, 201);
    id = criado.body.id;
  } finally { appA.server.close(); }

  const appA2 = await startApp(conn, 1);
  try {
    const doA = await req('GET', appA2.port, `/api/fluxos/${id}`);
    assert.equal(doA.status, 200, 'tenant A deveria ver o próprio fluxo');
    assert.equal(doA.body.nome, 'Fluxo do A');
  } finally { appA2.server.close(); }

  const appB = await startApp(conn, 2);
  try {
    const doB = await req('GET', appB.port, `/api/fluxos/${id}`);
    assert.equal(doB.status, 404, 'tenant B NÃO deveria conseguir ler o fluxo do tenant A');

    const putB = await req('PUT', appB.port, `/api/fluxos/${id}`, { nome: 'Sequestrado pelo B' });
    assert.equal(putB.status, 404, 'tenant B NÃO deveria conseguir editar o fluxo do tenant A');
  } finally { appB.server.close(); }

  const linha = conn._linhas.find((l) => l.ID === id);
  assert.equal(linha.NOME, 'Fluxo do A', 'o dado do tenant A não pode ter mudado');
  assert.equal(linha.VERSAO, 1);
});

test('lista de fluxos: tenant B não vê o fluxo criado pelo tenant A', async () => {
  const conn = criarBancoFalso();
  const DEF = { config: { inicio: 'x' }, nos: [{ id: 'x', tipo: 'encerrar', texto: 'fim' }] };

  const appA = await startApp(conn, 1);
  try {
    const criado = await req('POST', appA.port, '/api/fluxos', { nome: 'Só do A', definicao: DEF });
    assert.equal(criado.status, 201);
  } finally { appA.server.close(); }

  const appA2 = await startApp(conn, 1);
  try {
    const listaA = await req('GET', appA2.port, '/api/fluxos');
    assert.equal(listaA.status, 200);
    assert.equal(listaA.body.length, 1);
    assert.equal(listaA.body[0].nome, 'Só do A');
  } finally { appA2.server.close(); }

  const appB = await startApp(conn, 2);
  try {
    const listaB = await req('GET', appB.port, '/api/fluxos');
    assert.equal(listaB.status, 200);
    assert.deepEqual(listaB.body, [], 'tenant B não deveria ver o fluxo do tenant A na listagem');
  } finally { appB.server.close(); }
});
