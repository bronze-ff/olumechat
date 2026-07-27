'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { criptografar, descriptografar } = require('../ia/crypto');
const SEG = 'segredo-de-teste-com-mais-de-32-chars-1234567890';
const TENANT_A = 1;
const TENANT_B = 2;

test('round-trip devolve o texto original', () => {
  const blob = criptografar('sk-minha-chave-secreta', TENANT_A, SEG);
  assert.notEqual(blob, 'sk-minha-chave-secreta');
  assert.equal(descriptografar(blob, TENANT_A, SEG), 'sk-minha-chave-secreta');
});
test('formato é iv:tag:cipher', () => {
  assert.equal(criptografar('x', TENANT_A, SEG).split(':').length, 3);
});
test('adulteração do ciphertext falha (authTag)', () => {
  const [iv, tag, ct] = criptografar('x', TENANT_A, SEG).split(':');
  const adulterado = `${iv}:${tag}:${ct.slice(0, -2)}00`;
  assert.throws(() => descriptografar(adulterado, TENANT_A, SEG));
});
test('tenantId é obrigatório — chave é derivada por tenant', () => {
  assert.throws(() => criptografar('x', undefined, SEG), /tenantId/);
  assert.throws(() => criptografar('x', null, SEG), /tenantId/);
});
test('SEGURANÇA: blob cifrado para o tenant A não decifra com o tenantId do tenant B, mesmo com o mesmo segredo mestre', () => {
  // Defesa em profundidade (FIL-63): a RLS já impede o tenant B de LER a linha
  // do tenant A; isto prova que mesmo que o blob vaze por outro caminho, ele
  // não decifra sem o tenantId certo — a chave não é só o segredo mestre.
  const blob = criptografar('sk-do-tenant-A', TENANT_A, SEG);
  assert.throws(() => descriptografar(blob, TENANT_B, SEG), /Unsupported state|auth/i);
});
