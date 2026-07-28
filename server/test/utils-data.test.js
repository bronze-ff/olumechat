'use strict';
// utils/data.js — achado de review (FIL-76): a regex sozinha aceitava datas
// impossíveis ("2026-02-31", "2026-99-01") que chegavam cruas no Postgres e
// viravam 500 em vez do 400 esperado.
const test = require('node:test');
const assert = require('node:assert');
const { validarDataYYYYMMDD } = require('../utils/data');

class ErroFake extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; this.deFake = true; }
}

test('validarDataYYYYMMDD aceita data real', () => {
  assert.equal(validarDataYYYYMMDD('2026-08-01', 'Campo', ErroFake), '2026-08-01');
  assert.equal(validarDataYYYYMMDD('2024-02-29', 'Campo', ErroFake), '2024-02-29', 'ano bissexto');
});

test('validarDataYYYYMMDD rejeita formato errado', () => {
  assert.throws(() => validarDataYYYYMMDD('01/08/2026', 'Campo', ErroFake), (err) => err.status === 400);
  assert.throws(() => validarDataYYYYMMDD('', 'Campo', ErroFake), (err) => err.status === 400);
});

test('validarDataYYYYMMDD rejeita dia impossível dentro do mês (2026-02-31)', () => {
  assert.throws(() => validarDataYYYYMMDD('2026-02-31', 'Campo', ErroFake), (err) => err.status === 400);
});

test('validarDataYYYYMMDD rejeita mês impossível (2026-99-01)', () => {
  assert.throws(() => validarDataYYYYMMDD('2026-99-01', 'Campo', ErroFake), (err) => err.status === 400);
});

test('validarDataYYYYMMDD rejeita 29 de fevereiro em ano não-bissexto', () => {
  assert.throws(() => validarDataYYYYMMDD('2025-02-29', 'Campo', ErroFake), (err) => err.status === 400);
});
