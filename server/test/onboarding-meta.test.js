// Testes de negócio do checklist de onboarding assistido da Meta (FIL-81).
// Critérios de aceite cobertos aqui:
//  • GET mescla as 7 etapas fixas com o que existe no banco (etapa sem linha
//    = 'pendente');
//  • PUT valida etapa/status e faz upsert por (tenant_id, etapa);
//  • toda mudança de etapa grava auditoria com o ANTES e o DEPOIS de todo
//    campo editável — status, responsável, observação e data de referência
//    (achado de review #2: capturar só o status deixava a trilha incompleta);
//  • concluir a última etapa (webhook testado) só SUGERE a data de início de
//    cobrança quando (a) TODAS as etapas estão concluídas e (b) esta é a
//    transição que completa o processo, não um re-salvamento de metadado
//    numa etapa já concluída (achado de review #1).
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

const TODAS_MENOS = (excluida) => [
  'conta_criada', 'verificacao_empresa', 'waba_criada', 'numero_verificado',
  'templates_submetidos', 'templates_aprovados', 'webhook_testado',
].filter((e) => e !== excluida).map((etapa) => ({ ETAPA: etapa, STATUS: 'concluida', RESPONSAVEL: null, OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: 'op@falatta.com' }));

/**
 * "Banco" fake com estado mutável: o PUT de verdade faz SELECT (antes) →
 * INSERT ... ON CONFLICT (upsert) → INSERT auditoria → SELECT (todas as
 * etapas, já enxergando o upsert). Sem mutar `estado` no INSERT, a checagem
 * de "todas concluídas" nunca veria a própria etapa que acabou de mudar.
 */
function conexao({ linhas = [] } = {}) {
  const cap = [];
  const estado = linhas.map((l) => ({ ...l }));
  return { cap, estado, async execute(sql, binds = {}) {
    cap.push({ sql, binds });
    if (/INSERT INTO onboarding_meta_etapa/i.test(sql)) {
      const idx = estado.findIndex((x) => x.ETAPA === binds.etapa);
      const linha = {
        ETAPA: binds.etapa, STATUS: binds.status, RESPONSAVEL: binds.resp,
        OBSERVACAO: binds.obs, DATA_REFERENCIA: binds.dataRef, ATUALIZADO_POR: binds.atzPor,
      };
      if (idx >= 0) estado[idx] = linha; else estado.push(linha);
      return { rows: [] };
    }
    if (/SELECT \* FROM onboarding_meta_etapa/i.test(sql)) return { rows: estado };
    if (/SELECT status, responsavel, observacao, data_referencia FROM onboarding_meta_etapa WHERE etapa/i.test(sql)) {
      const l = estado.find((x) => x.ETAPA === binds.etapa);
      return { rows: l ? [l] : [] };
    }
    if (/SELECT etapa, status FROM onboarding_meta_etapa/i.test(sql)) {
      return { rows: estado.map((x) => ({ ETAPA: x.ETAPA, STATUS: x.STATUS })) };
    }
    return { rows: [] };
  } };
}

function comTenantFake(conn) {
  return async (_t, fn) => fn(conn);
}

test('GET / mescla as 7 etapas fixas com o que existe no banco', async () => {
  const conn = conexao({ linhas: [
    { ETAPA: 'conta_criada', STATUS: 'concluida', RESPONSAVEL: 'Ana', OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: 'op@falatta.com', ATUALIZADO_EM: '2026-07-01T00:00:00.000Z' },
  ] });
  const old = db.comTenant;
  db.comTenant = comTenantFake(conn);
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
  const old = db.comTenant;
  db.comTenant = comTenantFake(conexao());
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/etapa-invalida', { status: 'concluida' });
    assert.equal(r.status, 400);
  } finally { db.comTenant = old; }
});

test('PUT /:etapa com status desconhecido dá 400', async () => {
  const old = db.comTenant;
  db.comTenant = comTenantFake(conexao());
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/conta_criada', { status: 'lá-e-cá' });
    assert.equal(r.status, 400);
  } finally { db.comTenant = old; }
});

test('PUT /:etapa faz upsert e grava auditoria com quem, quando (automático) e o quê', async () => {
  const conn = conexao();
  const old = db.comTenant;
  db.comTenant = comTenantFake(conn);
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
    assert.equal(detalhe.etapa, 'verificacao_empresa');           // o quê
    assert.equal(detalhe.antes.status, 'pendente');                // o quê (antes)
    assert.equal(detalhe.depois.status, 'em_andamento');           // o quê (depois)
    assert.equal(detalhe.operadorId, 9);                           // quem
    assert.equal(detalhe.operador, 'op@falatta.com');              // quem
    // "quando" é automático (auditoria.criado_em = now(), coluna DEFAULT do
    // banco) — não há bind aqui de propósito, ver migração 001.
  } finally { db.comTenant = old; }
});

test('PUT /:etapa alterando só o responsável (status igual) audita o ANTES e o DEPOIS de responsável', async () => {
  const conn = conexao({ linhas: [
    { ETAPA: 'conta_criada', STATUS: 'em_andamento', RESPONSAVEL: 'Ana Antiga', OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: 'op@falatta.com' },
  ] });
  const old = db.comTenant;
  db.comTenant = comTenantFake(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/conta_criada', {
      status: 'em_andamento', responsavel: 'Bruno Novo',
    });
    assert.equal(r.status, 200);

    const audit = conn.cap.find((c) => /INSERT INTO auditoria/i.test(c.sql));
    const detalhe = JSON.parse(audit.binds.det);
    // Status não mudou — mas responsável mudou, e a trilha PRECISA mostrar isso.
    assert.equal(detalhe.antes.status, 'em_andamento');
    assert.equal(detalhe.depois.status, 'em_andamento');
    assert.equal(detalhe.antes.responsavel, 'Ana Antiga');
    assert.equal(detalhe.depois.responsavel, 'Bruno Novo');
  } finally { db.comTenant = old; }
});

test('PUT /:etapa alterando só a data de referência audita o ANTES e o DEPOIS dela', async () => {
  const conn = conexao({ linhas: [
    { ETAPA: 'templates_submetidos', STATUS: 'em_andamento', RESPONSAVEL: null, OBSERVACAO: null, DATA_REFERENCIA: '2026-06-01', ATUALIZADO_POR: null },
  ] });
  const old = db.comTenant;
  db.comTenant = comTenantFake(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/templates_submetidos', {
      status: 'em_andamento', dataReferencia: '2026-07-15',
    });
    assert.equal(r.status, 200);
    const audit = conn.cap.find((c) => /INSERT INTO auditoria/i.test(c.sql));
    const detalhe = JSON.parse(audit.binds.det);
    assert.equal(detalhe.antes.dataReferencia, '2026-06-01');
    assert.equal(detalhe.depois.dataReferencia, '2026-07-15');
  } finally { db.comTenant = old; }
});

test('concluir a última etapa com etapas anteriores pendentes NÃO sugere início de cobrança', async () => {
  // Só a etapa 7 no banco — as outras 6 nunca foram tocadas (pendente).
  const conn = conexao({ linhas: [{ ETAPA: 'webhook_testado', STATUS: 'em_andamento' }] });
  const old = db.comTenant;
  db.comTenant = comTenantFake(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/webhook_testado', { status: 'concluida' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sugestaoInicioCobranca, undefined, 'não sugere com etapas anteriores incompletas');
  } finally { db.comTenant = old; }
});

test('concluir a última etapa quando TODAS as outras já estão concluídas SUGERE início de cobrança', async () => {
  const conn = conexao({ linhas: [
    ...TODAS_MENOS('webhook_testado'),
    { ETAPA: 'webhook_testado', STATUS: 'em_andamento', RESPONSAVEL: null, OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: null },
  ] });
  const old = db.comTenant;
  db.comTenant = comTenantFake(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/webhook_testado', { status: 'concluida' });
    assert.equal(r.status, 200);
    assert.ok(r.body.sugestaoInicioCobranca, 'sugere a data');
    assert.match(r.body.sugestaoInicioCobranca.data, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!conn.cap.some((c) => /contrato/i.test(c.sql)), 'não altera contrato');
  } finally { db.comTenant = old; }
});

test('re-salvar a última etapa JÁ concluída (só mudando observação) NÃO gera uma sugestão nova', async () => {
  const conn = conexao({ linhas: [
    ...TODAS_MENOS('webhook_testado'),
    { ETAPA: 'webhook_testado', STATUS: 'concluida', RESPONSAVEL: null, OBSERVACAO: 'primeira nota', DATA_REFERENCIA: null, ATUALIZADO_POR: null },
  ] });
  const old = db.comTenant;
  db.comTenant = comTenantFake(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/webhook_testado', {
      status: 'concluida', observacao: 'nota atualizada',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.sugestaoInicioCobranca, undefined, 'não é a transição que completa — já estava concluída');
  } finally { db.comTenant = old; }
});

test('concluir uma etapa que NÃO é a última não sugere início de cobrança', async () => {
  const conn = conexao({ linhas: [
    ...TODAS_MENOS('templates_aprovados'),
    { ETAPA: 'templates_aprovados', STATUS: 'em_andamento', RESPONSAVEL: null, OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: null },
  ] });
  const old = db.comTenant;
  db.comTenant = comTenantFake(conn);
  try {
    const r = await req(app(), 'PUT', '/api/onboarding-meta/templates_aprovados', { status: 'concluida' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sugestaoInicioCobranca, undefined);
  } finally { db.comTenant = old; }
});
