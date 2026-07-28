// operador/onboarding.js — "quem está travado em qual etapa" (FIL-81),
// listagem cross-tenant do painel do operador. Roda em comOperador (bypassa
// RLS por natureza — ver operador/db.js); o fake só precisa devolver linhas
// plausíveis, como em operador-ia-config.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/pool');
const onboarding = require('../operador/onboarding');

function conexao({ tenants = [], etapas = [] } = {}) {
  return {
    async execute(sql) {
      if (/SELECT id, nome, slug, status FROM tenant/i.test(sql)) return { rows: tenants };
      if (/SELECT tenant_id, etapa, status, atualizado_em FROM onboarding_meta_etapa/i.test(sql)) {
        return { rows: etapas };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('listarProgresso: tenant sem nenhuma linha aparece travado na 1ª etapa (pendente)', async () => {
  db.getConnection = async () => conexao({
    tenants: [{ ID: 1, NOME: 'Cliente Novo', SLUG: 'cliente-novo', STATUS: 'ativo' }],
    etapas: [],
  });
  const r = await onboarding.listarProgresso();
  assert.equal(r.length, 1);
  assert.equal(r[0].etapasConcluidas, 0);
  assert.equal(r[0].etapaAtual.etapa, 'conta_criada');
  assert.equal(r[0].etapaAtual.status, 'pendente');
  assert.equal(r[0].concluido, false);
  assert.equal(r[0].travado, false); // 'pendente' não é 'bloqueada'
});

test('listarProgresso: identifica a etapa BLOQUEADA como o ponto de travamento', async () => {
  db.getConnection = async () => conexao({
    tenants: [{ ID: 2, NOME: 'Cliente Travado', SLUG: 'cliente-travado', STATUS: 'ativo' }],
    etapas: [
      { TENANT_ID: 2, ETAPA: 'conta_criada', STATUS: 'concluida', ATUALIZADO_EM: '2026-07-01T00:00:00.000Z' },
      { TENANT_ID: 2, ETAPA: 'verificacao_empresa', STATUS: 'bloqueada', ATUALIZADO_EM: '2026-07-10T00:00:00.000Z' },
    ],
  });
  const r = await onboarding.listarProgresso();
  assert.equal(r[0].etapasConcluidas, 1);
  assert.equal(r[0].etapaAtual.etapa, 'verificacao_empresa');
  assert.equal(r[0].travado, true);
});

test('listarProgresso: todas as 7 etapas concluídas marca o tenant como concluído', async () => {
  const etapas = [
    'conta_criada', 'verificacao_empresa', 'waba_criada', 'numero_verificado',
    'templates_submetidos', 'templates_aprovados', 'webhook_testado',
  ].map((etapa) => ({ TENANT_ID: 3, ETAPA: etapa, STATUS: 'concluida', ATUALIZADO_EM: '2026-07-15T00:00:00.000Z' }));
  db.getConnection = async () => conexao({
    tenants: [{ ID: 3, NOME: 'Cliente Pronto', SLUG: 'cliente-pronto', STATUS: 'ativo' }],
    etapas,
  });
  const r = await onboarding.listarProgresso();
  assert.equal(r[0].etapasConcluidas, 7);
  assert.equal(r[0].concluido, true);
  assert.equal(r[0].etapaAtual, null);
});

test('listarProgresso: separa corretamente as etapas de tenants diferentes', async () => {
  db.getConnection = async () => conexao({
    tenants: [
      { ID: 1, NOME: 'A', SLUG: 'a', STATUS: 'ativo' },
      { ID: 2, NOME: 'B', SLUG: 'b', STATUS: 'ativo' },
    ],
    etapas: [
      { TENANT_ID: 1, ETAPA: 'conta_criada', STATUS: 'concluida', ATUALIZADO_EM: null },
      { TENANT_ID: 2, ETAPA: 'conta_criada', STATUS: 'bloqueada', ATUALIZADO_EM: null },
    ],
  });
  const r = await onboarding.listarProgresso();
  const a = r.find((x) => x.tenantId === 1);
  const b = r.find((x) => x.tenantId === 2);
  assert.equal(a.etapasConcluidas, 1);
  assert.equal(b.etapasConcluidas, 0);
  assert.equal(b.travado, true);
});

// ===========================================================================
// listarEtapasDoTenant / atualizarEtapa (FIL-82) — cross-tenant, equivalente
// ao GET/PUT de api/onboardingMeta.js, mas sem exigir sessão de suporte.
// ===========================================================================

const OPERADOR = { id: 9, email: 'op@falatta.com' };

function conexaoEtapa({ tenantExiste = true, linhas = [] } = {}) {
  const cap = [];
  const estado = linhas.map((l) => ({ ...l }));
  return {
    cap,
    estado,
    async execute(sql, binds = {}) {
      cap.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), binds });
      const s = cap[cap.length - 1].sql;
      if (/^SELECT id FROM tenant WHERE id = :id/i.test(s)) {
        return { rows: tenantExiste ? [{ ID: binds.id }] : [] };
      }
      if (/^SELECT \* FROM onboarding_meta_etapa WHERE tenant_id = :tid$/i.test(s)) {
        return { rows: estado };
      }
      if (/^SELECT etapa, status FROM onboarding_meta_etapa WHERE tenant_id = :tid$/i.test(s)) {
        return { rows: estado.map((x) => ({ ETAPA: x.ETAPA, STATUS: x.STATUS })) };
      }
      if (/^SELECT status, responsavel, observacao, data_referencia FROM onboarding_meta_etapa WHERE tenant_id = :tid AND etapa = :etapa/i.test(s)) {
        const l = estado.find((x) => x.ETAPA === binds.etapa);
        return { rows: l ? [l] : [] };
      }
      if (/^INSERT INTO onboarding_meta_etapa/i.test(s)) {
        const idx = estado.findIndex((x) => x.ETAPA === binds.etapa);
        const linha = {
          TENANT_ID: binds.tid, ETAPA: binds.etapa, STATUS: binds.status, RESPONSAVEL: binds.resp,
          OBSERVACAO: binds.obs, DATA_REFERENCIA: binds.dataRef, ATUALIZADO_POR: binds.atzPor,
        };
        if (idx >= 0) estado[idx] = linha; else estado.push(linha);
        return { rows: [] };
      }
      if (/^INSERT INTO operador_auditoria/i.test(s)) return { rowsAffected: 1, rows: [] };
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function auditoriaRegistradaEtapa(conn) {
  return conn.cap.filter((c) => /^INSERT INTO operador_auditoria/i.test(c.sql));
}

test('listarEtapasDoTenant: 404 se o tenant não existe', async () => {
  db.getConnection = async () => conexaoEtapa({ tenantExiste: false });
  await assert.rejects(onboarding.listarEtapasDoTenant(999), (err) => err.deOperador && err.status === 404);
});

test('listarEtapasDoTenant: mescla as 7 etapas fixas com o que existe no banco', async () => {
  db.getConnection = async () => conexaoEtapa({
    linhas: [{ TENANT_ID: 5, ETAPA: 'conta_criada', STATUS: 'concluida', RESPONSAVEL: 'Ana', OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: 'op@falatta.com', ATUALIZADO_EM: new Date('2026-07-01T00:00:00Z') }],
  });
  const r = await onboarding.listarEtapasDoTenant(5);
  assert.equal(r.length, 7);
  assert.equal(r[0].etapa, 'conta_criada');
  assert.equal(r[0].status, 'concluida');
  assert.equal(r[0].responsavel, 'Ana');
  assert.equal(r[1].etapa, 'verificacao_empresa');
  assert.equal(r[1].status, 'pendente');
  assert.equal(r[1].responsavel, null);
});

test('atualizarEtapa: rejeita etapa desconhecida', async () => {
  db.getConnection = async () => conexaoEtapa();
  await assert.rejects(
    onboarding.atualizarEtapa({ operador: OPERADOR, tenantId: 5, etapa: 'etapa-invalida', dados: { status: 'concluida' } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('atualizarEtapa: rejeita status desconhecido', async () => {
  db.getConnection = async () => conexaoEtapa();
  await assert.rejects(
    onboarding.atualizarEtapa({ operador: OPERADOR, tenantId: 5, etapa: 'conta_criada', dados: { status: 'lá-e-cá' } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('atualizarEtapa: 404 se o tenant não existe', async () => {
  db.getConnection = async () => conexaoEtapa({ tenantExiste: false });
  await assert.rejects(
    onboarding.atualizarEtapa({ operador: OPERADOR, tenantId: 999, etapa: 'conta_criada', dados: { status: 'concluida' } }),
    (err) => err.deOperador && err.status === 404
  );
});

test('atualizarEtapa: faz upsert e audita o ANTES e o DEPOIS de todo campo editável', async () => {
  const conn = conexaoEtapa();
  db.getConnection = async () => conn;
  const r = await onboarding.atualizarEtapa({
    operador: OPERADOR, tenantId: 5, etapa: 'verificacao_empresa',
    dados: { status: 'em_andamento', observacao: 'protocolo 12345', responsavel: 'Bruno', dataReferencia: '2026-07-20' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'em_andamento');
  assert.equal(r.statusAnterior, 'pendente');

  const upsert = conn.cap.find((c) => /^INSERT INTO onboarding_meta_etapa/i.test(c.sql));
  assert.equal(upsert.binds.tid, 5);
  assert.equal(upsert.binds.etapa, 'verificacao_empresa');
  assert.equal(upsert.binds.status, 'em_andamento');
  assert.equal(upsert.binds.obs, 'protocolo 12345');
  assert.equal(upsert.binds.resp, 'Bruno');
  assert.equal(upsert.binds.dataRef, '2026-07-20');

  const aud = auditoriaRegistradaEtapa(conn);
  assert.equal(aud.length, 1);
  assert.equal(aud[0].binds.tenantId, 5);
  assert.equal(aud[0].binds.acao, 'onboarding_etapa_atualizada');
  const detalhe = JSON.parse(aud[0].binds.det);
  assert.equal(detalhe.antes.status, 'pendente');
  assert.equal(detalhe.depois.status, 'em_andamento');
  assert.equal(detalhe.depois.responsavel, 'Bruno');
});

test('atualizarEtapa: audita o ANTES real quando a etapa já tinha uma linha', async () => {
  const conn = conexaoEtapa({
    linhas: [{ TENANT_ID: 5, ETAPA: 'conta_criada', STATUS: 'em_andamento', RESPONSAVEL: 'Ana Antiga', OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: 'op@falatta.com' }],
  });
  db.getConnection = async () => conn;
  await onboarding.atualizarEtapa({
    operador: OPERADOR, tenantId: 5, etapa: 'conta_criada', dados: { status: 'em_andamento', responsavel: 'Bruno Novo' },
  });
  const aud = auditoriaRegistradaEtapa(conn);
  const detalhe = JSON.parse(aud[0].binds.det);
  assert.equal(detalhe.antes.responsavel, 'Ana Antiga');
  assert.equal(detalhe.depois.responsavel, 'Bruno Novo');
});

test('atualizarEtapa: rejeita data de referência impossível (2026-02-31)', async () => {
  db.getConnection = async () => conexaoEtapa();
  await assert.rejects(
    onboarding.atualizarEtapa({ operador: OPERADOR, tenantId: 5, etapa: 'conta_criada', dados: { status: 'concluida', dataReferencia: '2026-02-31' } }),
    (err) => err.deOperador && err.status === 400
  );
});

// ===========================================================================
// sugestaoInicioCobranca (achado [P2] de review do PR #28): o endpoint de
// sessão de suporte (api/onboardingMeta.js) já devolvia isto — o equivalente
// cross-tenant do operador perdia o sinal em silêncio. Mesmas 3 condições.
// ===========================================================================
const TODAS_MENOS = (excluida) => [
  'conta_criada', 'verificacao_empresa', 'waba_criada', 'numero_verificado',
  'templates_submetidos', 'templates_aprovados', 'webhook_testado',
].filter((e) => e !== excluida).map((etapa) => ({ TENANT_ID: 5, ETAPA: etapa, STATUS: 'concluida', RESPONSAVEL: null, OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: null }));

test('atualizarEtapa: concluir a última etapa com as outras 6 já concluídas SUGERE início de cobrança', async () => {
  const conn = conexaoEtapa({
    linhas: [...TODAS_MENOS('webhook_testado'), { TENANT_ID: 5, ETAPA: 'webhook_testado', STATUS: 'em_andamento', RESPONSAVEL: null, OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: null }],
  });
  db.getConnection = async () => conn;
  const r = await onboarding.atualizarEtapa({ operador: OPERADOR, tenantId: 5, etapa: 'webhook_testado', dados: { status: 'concluida' } });
  assert.ok(r.sugestaoInicioCobranca, 'sugere a data de início de cobrança');
  assert.match(r.sugestaoInicioCobranca.data, /^\d{4}-\d{2}-\d{2}$/);
});

test('atualizarEtapa: concluir a última etapa com etapas anteriores pendentes NÃO sugere', async () => {
  const conn = conexaoEtapa({ linhas: [{ TENANT_ID: 5, ETAPA: 'webhook_testado', STATUS: 'em_andamento', RESPONSAVEL: null, OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: null }] });
  db.getConnection = async () => conn;
  const r = await onboarding.atualizarEtapa({ operador: OPERADOR, tenantId: 5, etapa: 'webhook_testado', dados: { status: 'concluida' } });
  assert.equal(r.sugestaoInicioCobranca, undefined, 'não sugere com etapas anteriores incompletas');
});

test('atualizarEtapa: re-salvar a última etapa JÁ concluída (só mudando observação) NÃO gera sugestão nova', async () => {
  const conn = conexaoEtapa({
    linhas: [...TODAS_MENOS('webhook_testado'), { TENANT_ID: 5, ETAPA: 'webhook_testado', STATUS: 'concluida', RESPONSAVEL: null, OBSERVACAO: 'primeira nota', DATA_REFERENCIA: null, ATUALIZADO_POR: null }],
  });
  db.getConnection = async () => conn;
  const r = await onboarding.atualizarEtapa({ operador: OPERADOR, tenantId: 5, etapa: 'webhook_testado', dados: { status: 'concluida', observacao: 'nota atualizada' } });
  assert.equal(r.sugestaoInicioCobranca, undefined, 'não é a transição que completa — já estava concluída');
});

test('atualizarEtapa: concluir uma etapa que NÃO é a última não sugere início de cobrança', async () => {
  const conn = conexaoEtapa({
    linhas: [...TODAS_MENOS('templates_aprovados'), { TENANT_ID: 5, ETAPA: 'templates_aprovados', STATUS: 'em_andamento', RESPONSAVEL: null, OBSERVACAO: null, DATA_REFERENCIA: null, ATUALIZADO_POR: null }],
  });
  db.getConnection = async () => conn;
  const r = await onboarding.atualizarEtapa({ operador: OPERADOR, tenantId: 5, etapa: 'templates_aprovados', dados: { status: 'concluida' } });
  assert.equal(r.sugestaoInicioCobranca, undefined);
});
