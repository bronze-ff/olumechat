'use strict';
// ia/credencialOperador.js — cifra/decifra a credencial GLOBAL do operador
// (FIL-78) com o mesmo AES-256-GCM de ia/crypto.js, mas num domínio de chave
// dedicado (pseudo-id + contexto próprios), separado de qualquer tenant real.
process.env.JWT_SECRET = 'segredo-de-teste-com-mais-de-32-chars-1234567890';
const test = require('node:test');
const assert = require('node:assert');
const { cifrar, decifrar } = require('../ia/credencialOperador');
const { criptografar, descriptografar } = require('../ia/crypto');

test('round-trip: cifra e decifra a chave do operador', () => {
  const blob = cifrar('sk-operador-abc123');
  assert.equal(decifrar(blob), 'sk-operador-abc123');
});

test('formato do blob é iv:tag:ct, como o de tenant', () => {
  const blob = cifrar('sk-x');
  assert.equal(blob.split(':').length, 3);
});

test('SEGURANÇA: blob da credencial global NÃO decifra com a chave de nenhum tenant real', () => {
  const blob = cifrar('sk-operador-super-secreta');
  for (const tenantId of [1, 2, 999, 'operador-global']) {
    assert.throws(() => descriptografar(blob, tenantId), `tenantId ${tenantId} não deveria conseguir decifrar a credencial global`);
  }
});

test('SEGURANÇA: blob de um tenant NÃO decifra pela função da credencial global', () => {
  const blobDoTenant = criptografar('sk-do-tenant-1', 1);
  assert.throws(() => decifrar(blobDoTenant));
});

test('adulterar o blob (authTag) invalida a decifragem', () => {
  const blob = cifrar('sk-operador-xyz');
  const [iv, tag, ct] = blob.split(':');
  const tagAdulterada = tag.slice(0, -2) + (tag.slice(-2) === '00' ? '11' : '00');
  assert.throws(() => decifrar(`${iv}:${tagAdulterada}:${ct}`));
});
