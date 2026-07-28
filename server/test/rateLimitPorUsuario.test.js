// Testes do rate limit por USUÁRIO (server/utils/rateLimitPorUsuario.js).
// keyGenerator precisa ser o par tenantId+matrícula, não o IP: dois usuários
// no mesmo IP não podem dividir o mesmo teto, e isso é o que este arquivo prova
// isolado da rota de negócio (mais rápido e não depende do teto real do B2/B3).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { limiterPorUsuario } = require('../utils/rateLimitPorUsuario');

function app(max) {
  const a = express();
  a.use((req, _res, next) => {
    const m = req.headers['x-matricula'];
    if (m) req.user = { tenantId: 1, matricula: Number(m) };
    req.tenantId = 1;
    next();
  });
  a.get('/rota', limiterPorUsuario({ windowMs: 60_000, max, mensagem: 'devagar' }), (req, res) => res.json({ ok: true }));
  return a;
}

function get(port, matricula) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { method: 'GET', hostname: '127.0.0.1', port, path: '/rota', headers: matricula ? { 'x-matricula': matricula } : {} },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

test('rateLimitPorUsuario: bloqueia o usuário no teto e devolve JSON com "error"', async () => {
  const srv = app(3).listen(0);
  const port = srv.address().port;
  try {
    for (let i = 0; i < 3; i++) {
      const r = await get(port, 111);
      assert.equal(r.status, 200, `requisição ${i + 1} deveria passar`);
    }
    const bloqueada = await get(port, 111);
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.body.error, 'devagar');
  } finally { srv.close(); }
});

test('rateLimitPorUsuario: teto é POR USUÁRIO — outro usuário não é afetado pelo bloqueio', async () => {
  const srv = app(2).listen(0);
  const port = srv.address().port;
  try {
    await get(port, 222);
    await get(port, 222);
    const bloqueada = await get(port, 222);
    assert.equal(bloqueada.status, 429, 'usuário 222 estourou o teto');

    const outroUsuario = await get(port, 333);
    assert.equal(outroUsuario.status, 200, 'usuário 333 tem o próprio teto, intacto');
  } finally { srv.close(); }
});
