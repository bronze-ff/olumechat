'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('requisições concorrentes não compartilham o usuário do Sentry', () => {
  const r = spawnSync(process.execPath, [
    '--import', './observabilidade/instrument.mjs',
    'test/observabilidade-isolamento-child.js',
  ], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      SENTRY_DSN: 'https://public@127.0.0.1:9/1',
      SENTRY_ENVIRONMENT: 'dev',
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout || r.error);
  const linha = String(r.stdout).split('\n').find((l) => l.startsWith('ISOLAMENTO '));
  assert.ok(linha, r.stdout);
  const out = JSON.parse(linha.slice('ISOLAMENTO '.length));
  assert.equal(out.a.visto, 'u:1');
  assert.equal(out.b.visto, 'u:2');
  assert.equal(out.c.visto, null);
  assert.equal(out.fora, null);
});
