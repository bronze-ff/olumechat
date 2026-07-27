'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { criptografar, descriptografar } = require('../ia/crypto');
const SEG = 'segredo-de-teste-com-mais-de-32-chars-1234567890';

test('round-trip devolve o texto original', () => {
  const blob = criptografar('sk-minha-chave-secreta', SEG);
  assert.notEqual(blob, 'sk-minha-chave-secreta');
  assert.equal(descriptografar(blob, SEG), 'sk-minha-chave-secreta');
});
test('formato é iv:tag:cipher', () => {
  assert.equal(criptografar('x', SEG).split(':').length, 3);
});
test('adulteração do ciphertext falha (authTag)', () => {
  const [iv, tag, ct] = criptografar('x', SEG).split(':');
  const adulterado = `${iv}:${tag}:${ct.slice(0, -2)}00`;
  assert.throws(() => descriptografar(adulterado, SEG));
});
