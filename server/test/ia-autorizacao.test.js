'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { autorizado } = require('../ia/autorizacao');

test('telefone na lista ativa é autorizado', async () => {
  const conn = { async execute() { return { rows: [{ N: 1 }] }; } };
  assert.equal(await autorizado(conn, '5562999990000', 2), true);
});
test('fora da lista não é autorizado', async () => {
  const conn = { async execute() { return { rows: [{ N: 0 }] }; } };
  assert.equal(await autorizado(conn, '5562000000000', 2), false);
});
test('tabela inexistente fecha por padrão', async () => {
  const conn = { async execute() { const e = new Error('ORA-00942'); e.errorNum = 942; throw e; } };
  assert.equal(await autorizado(conn, 'x', 2), false);
});
test('casa pelas variantes do 9º dígito (Meta entrega sem o 9)', async () => {
  let binds;
  const conn = { async execute(_sql, b) { binds = b; return { rows: [{ N: 1 }] }; } };
  // Mensagem chega SEM o 9 (556283423192); autorizado guardado COM o 9.
  assert.equal(await autorizado(conn, '556283423192', 2), true);
  const vals = Object.keys(binds).filter((k) => k[0] === 't').map((k) => binds[k]);
  assert.ok(vals.includes('556283423192'), 'consulta a forma sem 9');
  assert.ok(vals.includes('5562983423192'), 'consulta a forma com 9');
  assert.equal(binds.n, 2);
});
