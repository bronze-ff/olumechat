// Testes de negócio do checklist de onboarding assistido da Meta (FIL-81).
// Critérios de aceite cobertos aqui:
//  • GET mescla as 7 etapas fixas com o que existe no banco (etapa sem linha
//    = 'pendente');
//  • PUT valida etapa/status e faz upsert por (tenant_id, etapa);
//  • toda mudança de etapa grava auditoria com quem (operador), quando
//    (automático) e o quê (etapa + status antes/depois);
//  • concluir a última etapa (webhook testado) SUGERE a data de início de
//    cobrança, sem alterar nenhum contrato (FIL-76 não mergeado).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const db = require('../db/pool');
const router = require('../api/onboardingMeta');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.tenantId = 1;
    req.user = { suporte: true, operadorId: 9, email: 'op@falatta.com' };
    next();
  });
  a.use('/api/onboarding-meta', router);
  return a;
}

function req(instancia, metodo, path, corpo) {
  return new Promise((resolve) => {
    const srv = instancia.listen(0, () => {
      const port = srv.address().port;
      const r = http.request(
        { port, path, method: metodo, headers: { 'content-type': 'application/json' } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }); });
        }
      );
      if (corpo) r.write(JSON.stringify(corpo));
      r.end();
    });
  });
}

function conexao({ linhas = [] } = {}) {
  const cap = [];
  return { cap, async execute(sql, binds = {}) {
    cap.push({ sql, binds });
    if (/SELECT \* FROM onboarding_meta_etapa/i.test(sql)) return { rows: linhas };
    if (/SELECT status FROM onboarding_meta_etapa WHERE etapa/i.test(sql)) {
      const l = linhas.find((x) => x.ETAPA === binds.etapa);
      return { rows: l ? [{ STATUS: l.STATUS }] : [] };
    }
    return { rows: [] };
  } };
}

test('GET / mescla as 7 etapas fixas com o que existe no banco', async () => {
  const conn = conexao({ linhas: [
    { ETAPA: 'conta_criada', STATUS: 'concluida', RESPONSAVEL: 'Ana', OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: 'op@falatta.com', ATUALIZADO_EM: '2026-07-01T00:00:00.000Z' },
  ] });
  const old = db.comTenant;
  db.comTenant = async (_t, fn) => fn(conn);
  try {
    const r = await req(app(), 'GET', '/api/onboarding-meta');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 7);
    assert.equal(r.body[0].etapa, 'conta_criada');
    assert.equal(r.body[0].status, 'concluida');
    assert.equal(r.body[0].responsavel, 'Ana');
    // Etapa sem linha no banco = pendente, mesmo campos presentes.
    assert.equal(r.body[1].etapa, 'verificacao_empresa');
    assert.equal(r.body[1].status, 'pendente');
    assert.equal(r.body[1].responsavel, null);
  } finally { db.comTenant = old; }
});

test('PUT /:etapa com chave desconhecida dá 400', async () => {
  const conn = conexao();
  const old = db.comTenant;
  db.comTenant = async (_t, fn) => fn(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/etapa-invalida', { status: 'concluida' });
    assert.equal(r.status, 400);
  } finally { db.comTenant = old; }
});

test('PUT /:etapa com status desconhecido dá 400', async () => {
  const conn = conexao();
  const old = db.comTenant;
  db.comTenant = async (_t, fn) => fn(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/conta_criada', { status: 'lá-e-cá' });
    assert.equal(r.status, 400);
  } finally { db.comTenant = old; }
});

test('PUT /:etapa faz upsert e grava auditoria com quem, quando (automático) e o quê', async () => {
  const conn = conexao();
  const old = db.comTenant;
  db.comTenant = async (_t, fn) => fn(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/verificacao_empresa', {
      status: 'em_andamento', observacao: 'protocolo 12345',
    });
    assert.equal(r.status, 200);

    const upsert = conn.cap.find((c) => /INSERT INTO onboarding_meta_etapa/i.test(c.sql));
    assert.ok(upsert, 'faz upsert');
    assert.equal(upsert.binds.etapa, 'verificacao_empresa');
    assert.equal(upsert.binds.status, 'em_andamento');
    assert.equal(upsert.binds.obs, 'protocolo 12345');

    const audit = conn.cap.find((c) => /INSERT INTO auditoria/i.test(c.sql));
    assert.ok(audit, 'grava auditoria');
    const detalhe = JSON.parse(audit.binds.det);
    assert.equal(detalhe.etapa, 'verificacao_empresa');           // o quê (parte 1)
    assert.equal(detalhe.statusAnterior, 'pendente');              // o quê (parte 2, antes)
    assert.equal(detalhe.statusNovo, 'em_andamento');              // o quê (parte 3, depois)
    assert.equal(detalhe.operadorId, 9);                           // quem
    assert.equal(detalhe.operador, 'op@falatta.com');              // quem
    // "quando" é automático (auditoria.criado_em = now(), coluna DEFAULT do
    // banco) — não há bind aqui de propósito, ver migração 001.
  } finally { db.comTenant = old; }
});

test('concluir a última etapa (webhook testado) SUGERE início de cobrança, sem tocar em contrato', async () => {
  const conn = conexao({ linhas: [{ ETAPA: 'webhook_testado', STATUS: 'em_andamento' }] });
  const old = db.comTenant;
  db.comTenant = async (_t, fn) => fn(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/webhook_testado', { status: 'concluida' });
    assert.equal(r.status, 200);
    assert.ok(r.body.sugestaoInicioCobranca, 'sugere a data');
    assert.match(r.body.sugestaoInicioCobranca.data, /^\d{4}-\d{2}-\d{2}$/);
    // Nenhuma query toca tabela de contrato: a sugestão é só na resposta.
    assert.ok(!conn.cap.some((c) => /contrato/i.test(c.sql)), 'não altera contrato');
  } finally { db.comTenant = old; }
});

test('concluir uma etapa que NÃO é a última não sugere início de cobrança', async () => {
  const conn = conexao({ linhas: [{ ETAPA: 'templates_aprovados', STATUS: 'em_andamento' }] });
  const old = db.comTenant;
  db.comTenant = async (_t, fn) => fn(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/templates_aprovados', { status: 'concluida' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sugestaoInicioCobranca, undefined);
  } finally { db.comTenant = old; }
});
