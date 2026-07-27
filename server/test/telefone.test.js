// Testes do tratamento do 9º dígito brasileiro.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizar, variantes } = require('../utils/telefone');

test('normalizar: adiciona DDI 55 em número BR de 11 dígitos', () => {
  assert.equal(normalizar('62 98342-3192'), '5562983423192');
  assert.equal(normalizar('(62) 8342-3192'), '556283423192'); // 10 díg (sem 9)
  assert.equal(normalizar('5562983423192'), '5562983423192'); // já completo
});

test('variantes: celular COM 9 também casa a forma SEM 9 (e vice-versa)', () => {
  // Digitado com 9 → também procura sem 9 (jeito que a Meta entrega)
  const comNove = variantes('5562983423192');
  assert.ok(comNove.includes('5562983423192'));
  assert.ok(comNove.includes('556283423192'));

  // Recebido sem 9 → também procura com 9
  const semNove = variantes('556283423192');
  assert.ok(semNove.includes('556283423192'));
  assert.ok(semNove.includes('5562983423192'));
});

test('variantes: número não-BR ou fixo fica só com a própria forma', () => {
  assert.deepEqual(variantes('551133334444'), ['551133334444']); // fixo SP (sem 9 de celular)
  assert.deepEqual(variantes('123456'), ['123456']);
});

test('acharContato: monta IN com as variantes', async () => {
  const { acharContato } = require('../utils/telefone');
  let capturado;
  const conn = { async execute(sql, binds) { capturado = { sql, binds }; return { rows: [{ ID: 9, NOME_PERFIL: 'X' }] }; } };
  const r = await acharContato(conn, '62 98342-3192');
  assert.equal(r.ID, 9);
  assert.match(capturado.sql, /TELEFONE IN \(:t0,:t1\)/);
  assert.equal(capturado.binds.t0, '5562983423192');
  assert.equal(capturado.binds.t1, '556283423192');
});
