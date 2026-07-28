// Testes de boot do JWT_SECRET (auth/secret.js) e OPERADOR_JWT_SECRET
// (operador/segredo.js) — B10. Ambos calculam o segredo UMA VEZ no load do
// módulo (mesmo padrão do storage/index.js — ver storage-secret-boot.test.js),
// então cada cenário roda num subprocesso Node isolado.
//
// Simulamos "não consegui persistir o .env" criando um DIRETÓRIO chamado
// ".env" no cwd do subprocesso: fs.writeFileSync(".env", ...) falha com
// EISDIR sem precisar mexer em permissão de arquivo (portável, inclusive
// no Windows, onde "read-only" em pasta não impede escrita de verdade).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AUTH_SECRET_MODULE = path.join(__dirname, '..', 'auth', 'secret.js');
const OPERADOR_SECRET_MODULE = path.join(__dirname, '..', 'operador', 'segredo.js');

function cwdComEnvDirTrap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'falatta-jwt-secret-'));
  fs.mkdirSync(path.join(dir, '.env')); // ".env" é uma PASTA — writeFileSync nela dá EISDIR
  return dir;
}

function requerEmSubprocesso(modulePath, env, cwd) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}); console.log('OK')`], {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
  });
}

test('auth/secret: produção sem JWT_SECRET E sem conseguir persistir falha o boot', () => {
  const dir = cwdComEnvDirTrap();
  const r = requerEmSubprocesso(AUTH_SECRET_MODULE, { NODE_ENV: 'production', JWT_SECRET: '' }, dir);
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /JWT_SECRET ausente e não foi possível persistir/);
});

test('auth/secret: dev/teste sem JWT_SECRET sobe normalmente mesmo sem conseguir persistir (não tenta persistir fora de produção)', () => {
  const dir = cwdComEnvDirTrap();
  const r = requerEmSubprocesso(AUTH_SECRET_MODULE, { NODE_ENV: 'development', JWT_SECRET: '' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('auth/secret: produção com JWT_SECRET forte definido sobe normalmente (nunca tenta persistir)', () => {
  const dir = cwdComEnvDirTrap();
  const r = requerEmSubprocesso(AUTH_SECRET_MODULE, { NODE_ENV: 'production', JWT_SECRET: 'segredo-de-producao-com-mais-de-32-caracteres' }, dir);
  assert.equal(r.status, 0, r.stderr);
});

test('operador/segredo: produção sem OPERADOR_JWT_SECRET E sem conseguir persistir falha o boot', () => {
  const dir = cwdComEnvDirTrap();
  const r = requerEmSubprocesso(OPERADOR_SECRET_MODULE, {
    NODE_ENV: 'production',
    JWT_SECRET: 'segredo-do-tenant-com-mais-de-32-caracteres',
    OPERADOR_JWT_SECRET: '',
  }, dir);
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /OPERADOR_JWT_SECRET ausente e não foi possível persistir/);
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
