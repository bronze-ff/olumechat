'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { autorizado } = require('../ia/autorizacao');
const TENANT_A = 1;
const TENANT_B = 2;

test('telefone na lista ativa é autorizado', async () => {
  const conn = { async execute() { return { rows: [{ N: 1 }] }; } };
  assert.equal(await autorizado(conn, TENANT_A, '5562999990000', 2), true);
});
test('fora da lista não é autorizado', async () => {
  const conn = { async execute() { return { rows: [{ N: 0 }] }; } };
  assert.equal(await autorizado(conn, TENANT_A, '5562000000000', 2), false);
});
test('tabela inexistente fecha por padrão', async () => {
  const conn = { async execute() { const e = new Error('relation "ia_autorizado" does not exist'); e.code = '42P01'; throw e; } };
  assert.equal(await autorizado(conn, TENANT_A, 'x', 2), false);
});
test('casa pelas variantes do 9º dígito (Meta entrega sem o 9)', async () => {
  let binds;
  const conn = { async execute(_sql, b) { binds = b; return { rows: [{ N: 1 }] }; } };
  // Mensagem chega SEM o 9 (556283423192); autorizado guardado COM o 9.
  assert.equal(await autorizado(conn, TENANT_A, '556283423192', 2), true);
  const vals = Object.keys(binds).filter((k) => k[0] === 't' && k !== 'tenantId').map((k) => binds[k]);
  assert.ok(vals.includes('556283423192'), 'consulta a forma sem 9');
  assert.ok(vals.includes('5562983423192'), 'consulta a forma com 9');
  assert.equal(binds.n, 2);
  assert.equal(binds.tenantId, TENANT_A);
});
test('SEGURANÇA: telefone autorizado só pro tenant A não autoriza no tenant B', async () => {
  // Fake conn simula a RLS: só conta a linha se o tenant_id do bind bater.
  const linhas = [{ tenant_id: TENANT_A, telefone: '5562999990000', numero_id: 2, ativo: true }];
  const conn = {
    async execute(_sql, binds) {
      const vs = Object.keys(binds).filter((k) => k[0] === 't' && k !== 'tenantId').map((k) => binds[k]);
      const n = linhas.filter((l) => l.tenant_id === binds.tenantId && l.numero_id === binds.n && l.ativo && vs.includes(l.telefone)).length;
      return { rows: [{ N: n }] };
    },
  };
  assert.equal(await autorizado(conn, TENANT_A, '5562999990000', 2), true);
  assert.equal(await autorizado(conn, TENANT_B, '5562999990000', 2), false, 'tenant B autorizado com telefone só do tenant A — VAZAMENTO');
});
