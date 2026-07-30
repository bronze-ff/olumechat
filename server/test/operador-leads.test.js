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
      if (/FROM lead_comercial\s*(WHERE[\s\S]*?)?\s*ORDER BY id DESC/i.test(sql)) {
        let filtrados = leadsExistentes;
        if (binds.status) filtrados = filtrados.filter((l) => l.STATUS === binds.status);
        if (binds.antes) filtrados = filtrados.filter((l) => l.ID < binds.antes);
        filtrados = [...filtrados].sort((a, b) => b.ID - a.ID);
        // `limite` já chega como page+1 (o mesmo truque de api/iaPedidos.js) —
        // o duble só precisa respeitar o LIMIT, quem decide "tem próxima" é listar().
        return { rows: filtrados.slice(0, binds.limite) };
      }
      if (/UPDATE lead_comercial\s+SET/i.test(sql)) {
        const l = leadsExistentes.find((x) => x.ID === binds.id);
        if (!l) return { rows: [] };
        // hasOwnProperty distingue "campo não fornecido" (bind ausente) de
        // "fornecido como null/vazio" (bind presente, valor null) — é
        // exatamente a distinção que os fixes [P2] da review do PR #42 exigem.
        if (Object.prototype.hasOwnProperty.call(binds, 'status')) l.STATUS = binds.status;
        if (Object.prototype.hasOwnProperty.call(binds, 'observacao')) l.OBSERVACAO = binds.observacao;
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
  assert.equal(todos.itens.length, 2);
  assert.equal(todos.proximo, null);
  const novos = await leads.listar({ status: 'novo' });
  assert.equal(novos.itens.length, 1);
  assert.equal(novos.itens[0].NOME, 'A');
});

test('listar: status inválido é rejeitado ANTES de tocar o banco', async () => {
  await assert.rejects(
    leads.listar({ status: 'zzz' }),
    (err) => err.deOperador && err.status === 400
  );
});

// Achado [P2] da review do PR #42: um LIMIT fixo sem cursor deixava lead
// antigo inalcançável. Mesmo padrão de api/iaPedidos.js — pede page+1, e o
// `id` (IDENTITY monotônico) vira o cursor exato para "continue daqui".
test('listar: pagina por cursor (id) — devolve `proximo` quando há mais e respeita o corte com `antes`', async () => {
  const base = Array.from({ length: 5 }, (_, i) => ({ ID: i + 1, STATUS: 'novo', NOME: `Lead ${i + 1}` }));
  db.getConnection = async () => conexao({ leadsExistentes: base });

  const pagina1 = await leads.listar({ limite: 2 });
  assert.deepEqual(pagina1.itens.map((l) => l.ID), [5, 4], 'mais recente (maior id) primeiro');
  assert.equal(pagina1.proximo, 4, 'cursor é o id do último item da página');

  const pagina2 = await leads.listar({ limite: 2, antes: pagina1.proximo });
  assert.deepEqual(pagina2.itens.map((l) => l.ID), [3, 2]);
  assert.equal(pagina2.proximo, 2);

  const pagina3 = await leads.listar({ limite: 2, antes: pagina2.proximo });
  assert.deepEqual(pagina3.itens.map((l) => l.ID), [1]);
  assert.equal(pagina3.proximo, null, 'última página não anuncia continuação');
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

// Achado [P2] da review do PR #42: `limitar('')` virava null e o COALESCE
// antigo restaurava a nota velha — "apagar a nota" respondia sucesso e nada
// mudava. Agora `observacao: ''` explícito precisa realmente limpar a coluna.
test('atualizarStatus: observação EXPLICITAMENTE vazia apaga a nota (não é a mesma coisa que omitir o campo)', async () => {
  const base = [{ ID: 7, STATUS: 'novo', OBSERVACAO: 'nota antiga' }];
  db.getConnection = async () => conexao({ leadsExistentes: base });
  const r = await leads.atualizarStatus({ operador: OPERADOR, id: 7, status: 'contatado', observacao: '' });
  assert.equal(r.OBSERVACAO, null, 'observacao vazia tem que limpar a nota, não preservar a antiga');
});

// Achado [P2] da review do PR #42: o front salva só a nota sem reenviar o
// status em memória, para não sobrescrever uma mudança de status feita por
// outra pessoa enquanto a nota era escrita.
test('atualizarStatus: status OMITIDO atualiza só a observação (não sobrescreve status alheio)', async () => {
  const base = [{ ID: 8, STATUS: 'contatado', OBSERVACAO: null }];
  const conn = conexao({ leadsExistentes: base });
  db.getConnection = async () => conn;
  const r = await leads.atualizarStatus({ operador: OPERADOR, id: 8, observacao: 'ligar de novo amanhã' });
  assert.equal(r.STATUS, 'contatado', 'status não pode mudar quando não foi enviado');
  assert.equal(r.OBSERVACAO, 'ligar de novo amanhã');
  const auditado = conn.cap.find((c) => /INSERT INTO operador_auditoria/i.test(c.sql));
  assert.equal(auditado.binds.acao, 'lead_observacao_atualizada', 'ação de auditoria distinta de mudança de status');
});

test('atualizarStatus: nem status nem observação → 400 de negócio, sem tocar o banco', async () => {
  await assert.rejects(
    leads.atualizarStatus({ operador: OPERADOR, id: 1 }),
    (err) => err.deOperador && err.status === 400
  );
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
    assert.equal(r.body.itens.length, 1);
    assert.equal(r.body.itens[0].nome, 'Ana');
    assert.equal(r.body.proximo, null);
  } finally { server.close(); }
});
