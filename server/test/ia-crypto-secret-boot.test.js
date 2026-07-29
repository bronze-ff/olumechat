// Testes de boot do IA_CRYPTO_KEY (server/ia/crypto.js) — FIL-93 (P0.5).
//
// A chave cifra credenciais de IA e tokens Meta por tenant. Ela é resolvida
// UMA VEZ no load do módulo (mesmo padrão do auth/secret.js, do
// operador/segredo.js e do storage/index.js) — por isso cada cenário roda
// num subprocesso Node isolado.
//
// Em produção o boot precisa EXIGIR IA_CRYPTO_KEY explicitamente — sem cair
// no fallback silencioso para JWT_SECRET (que existe só para não quebrar
// quem já rodava assim antes deste ticket, mas é frágil: JWT_SECRET pode ser
// rotacionado pelo módulo de auth, o que tornaria a chave de IA gravada
// indecifrável sem aviso nenhum no boot).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CRYPTO_MODULE = path.join(__dirname, '..', 'ia', 'crypto.js');

function requerEmSubprocesso(env) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CRYPTO_MODULE)}); console.log('OK')`], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('ia/crypto: produção SEM IA_CRYPTO_KEY falha o boot (mesmo com JWT_SECRET presente)', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'production',
    IA_CRYPTO_KEY: '',
    JWT_SECRET: 'segredo-do-tenant-com-mais-de-32-caracteres',
  });
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /IA_CRYPTO_KEY ausente em produção/);
});

test('ia/crypto: produção COM IA_CRYPTO_KEY sobe normalmente', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'production',
    IA_CRYPTO_KEY: 'chave-estavel-de-producao-32-bytes-hex',
    JWT_SECRET: 'segredo-do-tenant-com-mais-de-32-caracteres',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('ia/crypto: dev/teste SEM IA_CRYPTO_KEY usa fallback (JWT_SECRET) e só avisa (não derruba o boot)', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'development',
    IA_CRYPTO_KEY: '',
    JWT_SECRET: 'segredo-do-tenant-com-mais-de-32-caracteres',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /usando fallback JWT_SECRET/);
});

// Achado de review P2 (Codex, PR #39): "x" ou um espaço em branco passavam
// no guard antigo (só checava presença, não força). Mesmo padrão de
// auth/secret.js e operador/segredo.js: exige >=32 caracteres (após trim).
test('ia/crypto: produção com IA_CRYPTO_KEY curta ("x") falha o boot — presença sozinha não basta', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'production',
    IA_CRYPTO_KEY: 'x',
    JWT_SECRET: 'segredo-do-tenant-com-mais-de-32-caracteres',
  });
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /IA_CRYPTO_KEY fraco\/curto em produção/);
});

test('ia/crypto: produção com IA_CRYPTO_KEY só espaços falha o boot (trim antes de medir)', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'production',
    IA_CRYPTO_KEY: '                                   ', // 35 espaços — "presente" mas vazio de verdade
    JWT_SECRET: 'segredo-do-tenant-com-mais-de-32-caracteres',
  });
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /IA_CRYPTO_KEY ausente em produção/);
});
