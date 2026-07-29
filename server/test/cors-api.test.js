'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { criarCorsApi, origensPermitidas } = require('../utils/corsApi');

async function subir(opcoes) {
  const app = express();
  app.use('/api', criarCorsApi(opcoes));
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    fechar: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('CORS: APP_URL e lista extra são normalizados por origem', () => {
  const lista = origensPermitidas({
    appUrl: 'https://app.exemplo.com.br/algum/caminho',
    corsOrigins: 'https://preview.exemplo.com, inválida',
    nodeEnv: 'production',
  });
  assert.deepEqual([...lista], ['https://app.exemplo.com.br', 'https://preview.exemplo.com']);
});

test('CORS: origem permitida recebe headers e preflight 204', async () => {
  const ctx = await subir({ appUrl: 'https://app.exemplo.com.br', nodeEnv: 'production' });
  try {
    const r = await fetch(`${ctx.base}/api/ping`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.exemplo.com.br',
        'access-control-request-method': 'GET',
      },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.exemplo.com.br');
    assert.match(r.headers.get('vary') || '', /Origin/i);
  } finally {
    await ctx.fechar();
  }
});

test('CORS: origem desconhecida é recusada e chamada sem Origin segue', async () => {
  const ctx = await subir({ appUrl: 'https://app.exemplo.com.br', nodeEnv: 'production' });
  try {
    const negada = await fetch(`${ctx.base}/api/ping`, {
      headers: { origin: 'https://malicioso.example' },
    });
    assert.equal(negada.status, 403);

    const servidor = await fetch(`${ctx.base}/api/ping`);
    assert.equal(servidor.status, 200);
  } finally {
    await ctx.fechar();
  }
});

test('CORS: produção falha cedo sem origem configurada', () => {
  assert.throws(
    () => criarCorsApi({ nodeEnv: 'production' }),
    /APP_URL\/CORS_ORIGINS ausentes/
  );
});
