// Testes de boot do JWT_SECRET (auth/secret.js) e OPERADOR_JWT_SECRET
// (operador/segredo.js) — B10/FIL-93. Ambos calculam o segredo UMA VEZ no
// load do módulo (mesmo padrão do storage/index.js — ver
// storage-secret-boot.test.js), então cada cenário roda num subprocesso
// Node isolado.
//
// FIL-93 (P0.5): em produção o boot EXIGE o segredo pronto no ambiente — NUNCA
// gera nem grava um novo no .env (comportamento descartável em container).
// Gerar-e-persistir continua existindo só em dev/teste, e só em memória (sem
// tocar o .env).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AUTH_SECRET_MODULE = path.join(__dirname, '..', 'auth', 'secret.js');
const OPERADOR_SECRET_MODULE = path.join(__dirname, '..', 'operador', 'segredo.js');

function dirLimpo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'olume-jwt-secret-'));
}

function requerEmSubprocesso(modulePath, env, cwd) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}); console.log('OK')`], {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
  });
}

test('auth/secret: produção sem JWT_SECRET falha o boot imediatamente, sem gerar nem gravar no .env', () => {
  const dir = dirLimpo();
  const r = requerEmSubprocesso(AUTH_SECRET_MODULE, { NODE_ENV: 'production', JWT_SECRET: '' }, dir);
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /JWT_SECRET ausente em produção/);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false, 'não deveria ter tentado gravar segredo no .env em produção');
});

test('auth/secret: produção com JWT_SECRET fraco/curto também falha o boot', () => {
  const dir = dirLimpo();
  const r = requerEmSubprocesso(AUTH_SECRET_MODULE, { NODE_ENV: 'production', JWT_SECRET: 'curto-demais' }, dir);
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /JWT_SECRET fraco\/curto em produção/);
});

test('auth/secret: dev/teste sem JWT_SECRET sobe normalmente (gera em memória, não grava .env)', () => {
  const dir = dirLimpo();
  const r = requerEmSubprocesso(AUTH_SECRET_MODULE, { NODE_ENV: 'development', JWT_SECRET: '' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false, 'dev não persiste o segredo gerado');
});

test('auth/secret: produção com JWT_SECRET forte definido sobe normalmente (nunca gera nem grava)', () => {
  const dir = dirLimpo();
  const r = requerEmSubprocesso(AUTH_SECRET_MODULE, { NODE_ENV: 'production', JWT_SECRET: 'segredo-de-producao-com-mais-de-32-caracteres' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
});

test('operador/segredo: produção sem OPERADOR_JWT_SECRET falha o boot imediatamente, sem gerar nem gravar no .env', () => {
  const dir = dirLimpo();
  const r = requerEmSubprocesso(OPERADOR_SECRET_MODULE, {
    NODE_ENV: 'production',
    JWT_SECRET: 'segredo-do-tenant-com-mais-de-32-caracteres',
    OPERADOR_JWT_SECRET: '',
  }, dir);
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /OPERADOR_JWT_SECRET ausente em produção/);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false, 'não deveria ter tentado gravar segredo no .env em produção');
});

test('operador/segredo: segredo IGUAL ao do tenant falha o boot (separação de sessão é fronteira do super-admin)', () => {
  const IGUAL = 'mesmo-segredo-nos-dois-lados-32-chars-ou-mais';
  const r = requerEmSubprocesso(OPERADOR_SECRET_MODULE, {
    NODE_ENV: 'development',
    JWT_SECRET: IGUAL,
    OPERADOR_JWT_SECRET: IGUAL,
  });
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /OPERADOR_JWT_SECRET é IGUAL ao JWT_SECRET/);
});

test('operador/segredo: segredos DIFERENTES sobem normalmente', () => {
  const r = requerEmSubprocesso(OPERADOR_SECRET_MODULE, {
    NODE_ENV: 'development',
    JWT_SECRET: 'segredo-do-tenant-com-mais-de-32-caracteres',
    OPERADOR_JWT_SECRET: 'segredo-do-operador-bem-diferente-32-chars',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});
