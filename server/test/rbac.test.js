// Testes do RBAC (perfil papel+departamentos com cache TTL).
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const rbac = require('../auth/rbac');

function fakeConn({ atendente = null, deptos = [], capturas = [] } = {}) {
  return {
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM MC_ZAP_ATENDENTE WHERE MATRICULA')) {
        return { rows: atendente ? [atendente] : [] };
      }
      if (sql.startsWith('INSERT INTO MC_ZAP_ATENDENTE')) {
        return { outBinds: { id: [42] } };
      }
      if (sql.includes('FROM MC_ZAP_ATENDENTE_DEPTO')) {
        return { rows: deptos.map((d) => ({ DEPARTAMENTO_ID: d })) };
      }
      return { rows: [], outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('carregarPerfil: cria atendente novo como ATENDENTE', async () => {
  rbac.invalidar();
  delete process.env.DIRETORES_MATRICULAS;
  const capturas = [];
  db.getConnection = async () => fakeConn({ capturas });
  const p = await rbac.carregarPerfil(111, 'Fulano');
  assert.equal(p.atendenteId, 42);
  assert.equal(p.papel, 'ATENDENTE');
  assert.deepEqual(p.deptoIds, []);
});

test('carregarPerfil: matrícula em DIRETORES_MATRICULAS vira ADMIN', async () => {
  rbac.invalidar();
  process.env.DIRETORES_MATRICULAS = '999,222';
  db.getConnection = async () => fakeConn({});
  const p = await rbac.carregarPerfil(222, 'Diretor');
  assert.equal(p.papel, 'ADMIN');
});

test('carregarPerfil: diretor JÁ EXISTENTE rebaixado a ATENDENTE NÃO volta a ADMIN', async () => {
  rbac.invalidar();
  process.env.DIRETORES_MATRICULAS = '576';
  const capturas = [];
  db.getConnection = async () => fakeConn({ atendente: { ID: 5, PAPEL: 'ATENDENTE', ATIVO: 'S' }, capturas });
  const p = await rbac.carregarPerfil(576, 'Filippe');
  assert.equal(p.papel, 'ATENDENTE'); // antes do fix, o carregamento re-promovia pra ADMIN
  // e não pode ter rodado UPDATE de papel:
  assert.equal(capturas.some((c) => /UPDATE MC_ZAP_ATENDENTE SET PAPEL/.test(c.sql)), false);
  rbac.invalidar();
  delete process.env.DIRETORES_MATRICULAS;
});

test('carregarPerfil: existente devolve papel/deptos e usa cache na 2ª chamada', async () => {
  rbac.invalidar();
  delete process.env.DIRETORES_MATRICULAS;
  let chamadas = 0;
  db.getConnection = async () => { chamadas++; return fakeConn({ atendente: { ID: 7, PAPEL: 'SUPERVISOR', ATIVO: 'S' }, deptos: [1, 3] }); };
  const p1 = await rbac.carregarPerfil(333);
  const p2 = await rbac.carregarPerfil(333);
  assert.equal(p1.papel, 'SUPERVISOR');
  assert.deepEqual(p1.deptoIds, [1, 3]);
  assert.equal(p2, p1);     // mesmo objeto = veio do cache
  assert.equal(chamadas, 1); // só 1 ida ao banco
});

test('invalidar: força nova consulta', async () => {
  rbac.invalidar();
  delete process.env.DIRETORES_MATRICULAS;
  let chamadas = 0;
  db.getConnection = async () => { chamadas++; return fakeConn({ atendente: { ID: 7, PAPEL: 'ATENDENTE', ATIVO: 'S' } }); };
  await rbac.carregarPerfil(444);
  rbac.invalidar(444);
  await rbac.carregarPerfil(444);
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
  delete process.env.DIRETORES_MATRICULAS;
  db.getConnection = async () => fakeConn({ atendente: { ID: 9, PAPEL: 'ATENDENTE', ATIVO: 'N' } });
  let status;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await rbac.anexarPerfil({ user: { matricula: 555 } }, res, () => {});
  assert.equal(status, 403);
});
