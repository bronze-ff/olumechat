// scripts/carga/saida.test.js — Código de saída do harness (FIL-110).
//
//   node --test scripts/carga/*.test.js
//
// Existe porque vazamento entre tenants saía com status 0: o log dizia
// "VIOLAÇÃO" e a automação lia sucesso. Forçar um vazamento de verdade num
// teste exigiria quebrar a RLS do produto — então o que se cobre aqui é a
// TRADUÇÃO do resultado em código de saída, que era exatamente a peça que
// faltava.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { codigoDeSaida } = require('./executar');

test('sem cenário de isolamento, sai 0', () => {
  assert.equal(codigoDeSaida({}).codigo, 0);
  assert.equal(codigoDeSaida({ sse: { quebra: { degrau: 6400 } } }).codigo, 0);
});

test('ponto de quebra encontrado NÃO é falha — é o objetivo do teste', () => {
  const r = codigoDeSaida({
    sse: { quebra: { degrau: 6400, criterios: ['72,7% das conexões falharam'] } },
    isolamento: { ok: true, conclusivo: true },
  });
  assert.equal(r.codigo, 0);
});

test('vazamento entre tenants sai 3', () => {
  const r = codigoDeSaida({
    isolamento: { ok: false, conclusivo: true, violacoes: [{ recebeu: 'carga-fil110-t02' }] },
  });
  assert.equal(r.codigo, 3);
  assert.match(r.mensagem, /vazamento/i);
});

test('resultado inconclusivo sai 4 — "não provei" não é "não vazou"', () => {
  const r = codigoDeSaida({
    isolamento: { ok: true, conclusivo: false, semEntrega: ['carga-fil110-t03'] },
  });
  assert.equal(r.codigo, 4);
  assert.match(r.mensagem, /inconclusivo/i);
});

test('vazamento tem precedência sobre inconclusivo', () => {
  const r = codigoDeSaida({ isolamento: { ok: false, conclusivo: false } });
  assert.equal(r.codigo, 3);
});

test('isolamento limpo e conclusivo sai 0', () => {
  const r = codigoDeSaida({ isolamento: { ok: true, conclusivo: true } });
  assert.equal(r.codigo, 0);
  assert.equal(r.mensagem, null);
});
