// Testes do fallback de decifragem LEGADO em server/ia/crypto.js — achado P1
// da review cruzada (Codex) do PR #39/FIL-93: qualquer banco existente
// (inclusive o dev atual) tem credenciais de IA/Meta cifradas com o fallback
// JWT_SECRET, de antes deste ticket exigir IA_CRYPTO_KEY explícito. Ao
// exigir a chave dedicada, a autenticação AES-GCM desses blobs antigos
// passaria a falhar (chave errada) — decifragem que funcionava até ontem
// quebraria no deploy deste PR.
//
// Fix: descriptografar() tenta a chave PRIMÁRIA (IA_CRYPTO_KEY, se setada);
// se falhar E a chamada não fixou um segredo explícito (only o caso de uso
// real via env — testes que passam `segredo` continuam sem fallback, de
// propósito, pra provar erro em blob adulterado), tenta a chave LEGADA
// (JWT_SECRET) e, se essa decifrar, loga aviso pedindo re-salvamento.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criptografar, descriptografar } = require('../ia/crypto');

const TENANT = 42;

function comEnv(vars, fn) {
  const originais = {};
  for (const k of Object.keys(vars)) originais[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(originais)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('descriptografar: blob LEGADO (cifrado só com JWT_SECRET, antes do IA_CRYPTO_KEY existir) continua decifrando depois que a chave dedicada passa a existir', () => {
  const blobLegado = comEnv({ IA_CRYPTO_KEY: undefined, JWT_SECRET: 'jwt-secret-legado-com-mais-de-32-caracteres' }, () =>
    criptografar('sk-legado', TENANT));

  const texto = comEnv({
    IA_CRYPTO_KEY: 'chave-nova-dedicada-com-mais-de-32-caracteres',
    JWT_SECRET: 'jwt-secret-legado-com-mais-de-32-caracteres',
  }, () => descriptografar(blobLegado, TENANT));

  assert.equal(texto, 'sk-legado');
});

test('descriptografar: blob NOVO (já cifrado com IA_CRYPTO_KEY) decifra normalmente, sem precisar do fallback', () => {
  const texto = comEnv({
    IA_CRYPTO_KEY: 'chave-nova-dedicada-com-mais-de-32-caracteres',
    JWT_SECRET: 'outro-jwt-secret-bem-diferente-32-chars',
  }, () => {
    const blob = criptografar('sk-novo', TENANT);
    return descriptografar(blob, TENANT);
  });
  assert.equal(texto, 'sk-novo');
});

test('descriptografar: chamada com segredo EXPLÍCITO não usa o fallback legado — blob adulterado continua falhando', () => {
  const SEG = 'segredo-explicito-de-teste-com-32-chars-ok';
  const [iv, tag, ct] = criptografar('x', TENANT, SEG).split(':');
  const adulterado = `${iv}:${tag}:${ct.slice(0, -2)}00`;
  assert.throws(() => descriptografar(adulterado, TENANT, SEG));
});

test('descriptografar: sem IA_CRYPTO_KEY configurada (mundo pré-FIL-93) blob adulterado continua falhando — sem fallback fantasma', () => {
  comEnv({ IA_CRYPTO_KEY: undefined, JWT_SECRET: 'jwt-secret-unico-com-mais-de-32-caracteres' }, () => {
    const [iv, tag, ct] = criptografar('x', TENANT).split(':');
    const adulterado = `${iv}:${tag}:${ct.slice(0, -2)}00`;
    assert.throws(() => descriptografar(adulterado, TENANT));
  });
});
