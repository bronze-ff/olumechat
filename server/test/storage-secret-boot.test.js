// Testes do segredo de assinatura do storage (server/storage/index.js).
// A chave de mídia é previsível ({tenantId}/{conversaId}/{arquivo}) — sem um
// segredo real, qualquer um forjaria o token de outro tenant. Em produção o
// boot precisa falhar em vez de cair no fallback 'dev-storage-secret'.
//
// O segredo é resolvido UMA VEZ no load do módulo (mesmo padrão do
// auth/secret.js e do db/pool.js::initPool) — por isso cada cenário roda num
// subprocesso Node isolado, com require cache e env próprios, em vez de
// re-requerer '../storage' dentro do processo da suíte (que já rodou outros
// arquivos e deixou META_APP_SECRET/NODE_ENV setados globalmente).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STORAGE_MODULE = path.join(__dirname, '..', 'storage', 'index.js');

function requerEmSubprocesso(env) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(STORAGE_MODULE)}); console.log('OK')`], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('storage: produção SEM segredo real falha o boot (fallback público desligado)', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'production',
    STORAGE_SIGNING_SECRET: '',
    META_APP_SECRET: '',
  });
  assert.notEqual(r.status, 0, 'processo deveria sair com erro');
  assert.match(r.stderr, /STORAGE_SIGNING_SECRET\/META_APP_SECRET não definidos em produção/);
});

test('storage: produção COM STORAGE_SIGNING_SECRET sobe normalmente', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'production',
    STORAGE_SIGNING_SECRET: 'segredo-real-de-producao-bem-forte',
    META_APP_SECRET: '',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('storage: produção COM META_APP_SECRET (fallback do WhatsApp) também sobe', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'production',
    STORAGE_SIGNING_SECRET: '',
    META_APP_SECRET: 'segredo-da-meta',
  });
  assert.equal(r.status, 0, r.stderr);
});

test('storage: dev/teste SEM segredo real usa fallback e só avisa (não derruba o boot)', () => {
  const r = requerEmSubprocesso({
    NODE_ENV: 'development',
    STORAGE_SIGNING_SECRET: '',
    META_APP_SECRET: '',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /usando segredo de DEV/);
});
