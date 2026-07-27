// Testes do RBAC (perfil papel+departamentos com cache TTL), escopado por
// tenant (FIL-59). Mocka db.comTenant() — o contrato do wrapper (RLS,
// set_config transaction-scoped) já é provado em test/db-tenant.test.js.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../db/pool');
const rbac = require('../auth/rbac');

/** Fake conn de uma única "consulta de perfil": exige tenant_id em toda query. */
function fakeConn({ atendente = null, deptos = [], numeros = [], capturas = [] } = {}) {
  return {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      assert.ok('tenantId' in binds, `query sem tenant_id: ${sql}`);
      if (/FROM atendente WHERE/.test(sql)) {
        return { rows: atendente ? [atendente] : [] };
      }
      if (/^\s*INSERT INTO atendente/.test(sql)) {
        return { outBinds: { id: [42] } };
      }
      if (/FROM atendente_depto/.test(sql)) {
        return { rows: deptos.map((d) => ({ DEPARTAMENTO_ID: d })) };
      }
      if (/FROM atendente_numero/.test(sql)) {
        return { rows: numeros.map((n) => ({ NUMERO_ID: n })) };
      }
      return { rows: [], outBinds: {} };
    },
  };
}

/** Mock de db.comTenant que ignora persistência entre chamadas (fixture fixa). */
function mockComTenant(fixture) {
  return async (tenantId, fn) => fn(fakeConn(fixture));
}

test('carregarPerfil: cria atendente novo como ATENDENTE', async () => {
  rbac.invalidar();
  const capturas = [];
  db.comTenant = mockComTenant({ capturas });
  const p = await rbac.carregarPerfil(1, 111, 'Fulano');
  assert.equal(p.atendenteId, 42);
  assert.equal(p.papel, 'ATENDENTE');
  assert.deepEqual(p.deptoIds, []);
  assert.ok(capturas.every((c) => c.binds.tenantId === 1), 'alguma query rodou sem o tenant_id do contexto');
});

// FIL-67 removeu o bootstrap de ADMIN por variável de ambiente: num SaaS
// multi-tenant ele promoveria a MESMA matrícula em TODOS os tenants. O papel
// agora vem só do banco — nenhum ambiente promove ninguém.
test('carregarPerfil: nenhuma variável de ambiente promove a ADMIN', async () => {
  rbac.invalidar();
  db.comTenant = mockComTenant({});
  const p = await rbac.carregarPerfil(1, 222, 'Ex-diretor');
  assert.equal(p.papel, 'ATENDENTE');
  // Guarda de regressão: o módulo não pode voltar a ler configuração de
  // ambiente para decidir papel.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'auth', 'rbac.js'), 'utf8');
  assert.equal(/process\.env/.test(fonte), false, 'papel não pode depender de env');
});

test('carregarPerfil: papel do banco manda — carregar não reescreve papel', async () => {
  rbac.invalidar();
  const capturas = [];
  db.comTenant = mockComTenant({ atendente: { ID: 5, PAPEL: 'ATENDENTE', ATIVO: 'S' }, capturas });
  const p = await rbac.carregarPerfil(1, 576, 'Filippe');
  assert.equal(p.papel, 'ATENDENTE');
  // e não pode ter rodado UPDATE de papel:
  assert.equal(capturas.some((c) => /UPDATE atendente SET papel/i.test(c.sql)), false);
  rbac.invalidar();
});

test('carregarPerfil: existente devolve papel/deptos e usa cache na 2ª chamada', async () => {
  rbac.invalidar();
  let chamadas = 0;
  db.comTenant = async (tenantId, fn) => {
    chamadas++;
    return fn(fakeConn({ atendente: { ID: 7, PAPEL: 'SUPERVISOR', ATIVO: 'S' }, deptos: [1, 3] }));
  };
  const p1 = await rbac.carregarPerfil(1, 333);
  const p2 = await rbac.carregarPerfil(1, 333);
  assert.equal(p1.papel, 'SUPERVISOR');
  assert.deepEqual(p1.deptoIds, [1, 3]);
  assert.equal(p2, p1);     // mesmo objeto = veio do cache
  assert.equal(chamadas, 1); // só 1 ida ao banco
});

test('invalidar: força nova consulta', async () => {
  rbac.invalidar();
  let chamadas = 0;
  db.comTenant = async (tenantId, fn) => {
    chamadas++;
    return fn(fakeConn({ atendente: { ID: 7, PAPEL: 'ATENDENTE', ATIVO: 'S' } }));
  };
  await rbac.carregarPerfil(1, 444);
  rbac.invalidar(444);
  await rbac.carregarPerfil(1, 444);
  assert.equal(chamadas, 2);
});

test('exigirPapel: bloqueia papel não listado (403) e libera o listado', () => {
  const mw = rbac.exigirPapel('ADMIN', 'SUPERVISOR');
  let status, passou = false;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  mw({ perfil: { papel: 'ATENDENTE' } }, res, () => { passou = true; });
  assert.equal(status, 403);
  assert.equal(passou, false);
  mw({ perfil: { papel: 'ADMIN' } }, res, () => { passou = true; });
  assert.equal(passou, true);
});

test('anexarPerfil: usuário desativado recebe 403', async () => {
  rbac.invalidar();
  db.comTenant = mockComTenant({ atendente: { ID: 9, PAPEL: 'ATENDENTE', ATIVO: 'N' } });
  let status;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await rbac.anexarPerfil({ user: { tenantId: 1, matricula: 555 } }, res, () => {});
  assert.equal(status, 403);
});

test('anexarPerfil: sem tenantId no req.user recebe 401', async () => {
  let status;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await rbac.anexarPerfil({ user: { matricula: 555 } }, res, () => {});
  assert.equal(status, 401);
});

// ---------------------------------------------------------------------------
// Critério de aceite do FIL-59: usuário do tenant A não recebe perfil/papel
// ao consultar no contexto do tenant B.
// ---------------------------------------------------------------------------
test('carregarPerfil: isolamento de tenant — mesma matrícula não vaza de A para B', async () => {
  rbac.invalidar();

  // "Banco" com um atendente ADMIN de matrícula 777 SÓ no tenant 1.
  const banco = { 1: [{ matricula: 777, ID: 10, PAPEL: 'ADMIN', ATIVO: 'S' }] };
  let proximoId = 100;
  db.comTenant = async (tenantId, fn) => {
    const linhas = banco[tenantId] || (banco[tenantId] = []);
    const conn = {
      async execute(sql, binds) {
        assert.equal(binds.tenantId, tenantId, `query sem tenant_id do contexto corrente: ${sql}`);
        if (/FROM atendente WHERE/.test(sql)) {
          const row = linhas.find((r) => r.matricula === binds.m);
          return { rows: row ? [row] : [] };
        }
        if (/^\s*INSERT INTO atendente/.test(sql)) {
          const novo = { matricula: binds.m, ID: ++proximoId, PAPEL: binds.p, ATIVO: 'S' };
          linhas.push(novo);
          return { outBinds: { id: [novo.ID] } };
        }
        return { rows: [] };
      },
    };
    return fn(conn);
  };

  const perfilA = await rbac.carregarPerfil(1, 777, 'Admin do tenant A');
  assert.equal(perfilA.atendenteId, 10);
  assert.equal(perfilA.papel, 'ADMIN');

  // MESMA matrícula, tenant B: não pode enxergar o registro do A — precisa
  // criar um atendente NOVO (ATENDENTE, não ADMIN) em vez de herdar o perfil.
  const perfilB = await rbac.carregarPerfil(2, 777, 'Mesma matrícula, outra empresa');
  assert.notEqual(perfilB.atendenteId, perfilA.atendenteId, 'tenant B recebeu o atendenteId do tenant A — VAZAMENTO');
  assert.equal(perfilB.papel, 'ATENDENTE', 'tenant B herdou o papel ADMIN do tenant A — VAZAMENTO');
});
