'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { criptografar, descriptografar } = require('../ia/crypto');
const { adulterarHex, adulterarCipher } = require('./apoio/adulterar');
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
  const blob = criptografar('x', TENANT_A, SEG);
  const adulterado = adulterarCipher(blob);
  assert.notEqual(adulterado, blob);
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

// --- FIL-111: o teste de adulteração era ele próprio não-determinístico.
// Trocar o último byte por um valor FIXO ("00") não adultera nada quando o byte
// já é esse valor — 1 em 256 execuções o blob "adulterado" saía idêntico ao
// original, decifrava, e a suíte falhava sozinha. Foi o que deixou a `main`
// vermelha num merge só de documentação. Os dois testes abaixo são o portão
// contra a volta do padrão: o primeiro é exaustivo e determinístico, o segundo
// exercita o caminho real muitas vezes.
test('FIL-111: a adulteração SEMPRE altera o byte — para os 256 valores possíveis, inclusive 00 e ff', () => {
  for (let b = 0; b <= 0xff; b++) {
    const hex = `ab${b.toString(16).padStart(2, '0')}`;
    const alterado = adulterarHex(hex);
    assert.notEqual(alterado, hex, `adulterarHex não mudou nada para o byte ${b.toString(16)}`);
    assert.equal(alterado.length, hex.length);
    assert.equal(alterado.slice(0, -2), hex.slice(0, -2), 'só o último byte pode mudar');
  }
});

test('FIL-111: 500 execuções do caminho adulterado — a decifragem falha em TODAS', () => {
  for (let i = 0; i < 500; i++) {
    const blob = criptografar('x', TENANT_A, SEG); // ct de 1 byte: o pior caso do sorteio
    const adulterado = adulterarCipher(blob);
    assert.notEqual(adulterado, blob, `execução ${i}: adulteração virou no-op (${blob})`);
    assert.throws(() => descriptografar(adulterado, TENANT_A, SEG), `execução ${i}: blob adulterado decifrou`);
  }
});
