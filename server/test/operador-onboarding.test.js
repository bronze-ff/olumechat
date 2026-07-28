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
