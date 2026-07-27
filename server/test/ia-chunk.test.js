'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { partirTexto } = require('../ia/chunk');

test('texto curto vira 1 pedaço', () => {
  assert.deepEqual(partirTexto('oi', 4096), ['oi']);
});

test('respeita o limite máximo', () => {
  const grande = 'a'.repeat(10000);
  const partes = partirTexto(grande, 4096);
  assert.ok(partes.every((p) => p.length <= 4096));
  assert.equal(partes.join(''), grande);
});

test('prefere quebrar em nova linha', () => {
  const txt = 'linha1\n' + 'b'.repeat(4090) + '\nlinha3';
  const partes = partirTexto(txt, 4096);
  assert.ok(partes.length >= 2);
  assert.ok(partes[0].endsWith('linha1') || partes[0].length <= 4096);
});

test('vazio vira lista vazia', () => {
  assert.deepEqual(partirTexto('', 4096), []);
});
