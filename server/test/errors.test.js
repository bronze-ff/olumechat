// Testes do tradutor de erros da Meta para mensagens amigáveis.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mensagemAmigavel } = require('../graph/errors');

test('mensagemAmigavel: códigos conhecidos têm texto claro', () => {
  assert.match(mensagemAmigavel(131047), /janela de 24h/i);
  assert.match(mensagemAmigavel(130429), /aguarde/i);
  assert.match(mensagemAmigavel(132001), /template/i);
  assert.match(mensagemAmigavel(190), /token/i);
});

test('mensagemAmigavel: aceita código como string', () => {
  assert.equal(mensagemAmigavel('131047'), mensagemAmigavel(131047));
});

test('mensagemAmigavel: código desconhecido usa fallback com a msg crua', () => {
  assert.match(mensagemAmigavel(999999, 'algo deu errado'), /999999.*algo deu errado/);
});

test('mensagemAmigavel: desconhecido e sem msg crua → genérico', () => {
  assert.match(mensagemAmigavel(undefined), /não foi possível enviar/i);
});
