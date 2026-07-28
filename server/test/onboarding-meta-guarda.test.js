// Teste do guard de papel em api/onboardingMeta.js (FIL-81, critério de
// aceite: "só o operador lê/escreve o onboarding; tenant recebe 403").
// Mesmo padrão de api/meta.js::exigirSuporteOperador (ver
// meta-signup-guarda.test.js): nenhum JWT de tenant comum passa, nem para
// LEITURA — só a sessão de suporte (o operador atuando dentro do tenant).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const router = require('../api/onboardingMeta');

function app({ papel, suporte } = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.tenantId = 1;
    req.user = suporte ? { suporte: true, operadorId: 9, email: 'op@falatta.com' } : { matricula: 10 };
    req.perfil = { atendenteId: 1, papel: papel || 'ATENDENTE' };
    next();
  });
  a.use('/api/onboarding-meta', router);
  return a;
}

function req(instancia, metodo, path, corpo) {
  return new Promise((resolve) => {
    const srv = instancia.listen(0, () => {
      const port = srv.address().port;
      const r = http.request(
        { port, path, method: metodo, headers: { 'content-type': 'application/json' } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }); });
        }
      );
      if (corpo) r.write(JSON.stringify(corpo));
      r.end();
    });
  });
}

for (const papel of ['ATENDENTE', 'SUPERVISOR', 'ADMIN', 'AUDITOR']) {
  test(`GET /: ${papel} sem sessão de suporte recebe 403`, async () => {
    const r = await req(app({ papel }), 'GET', '/api/onboarding-meta');
    assert.equal(r.status, 403);
  });

  test(`PUT /:etapa: ${papel} sem sessão de suporte recebe 403`, async () => {
    const r = await req(app({ papel }), 'PUT', '/api/onboarding-meta/conta_criada', { status: 'concluida' });
    assert.equal(r.status, 403);
  });
}

test('GET /: sessão de suporte passa da guarda (não trava em 403)', async () => {
  const conn = { async execute() { return { rows: [] }; } };
  const db = require('../db/pool');
  const old = db.comTenant;
  db.comTenant = async (_t, fn) => fn(conn);
  try {
    const r = await req(app({ suporte: true }), 'GET', '/api/onboarding-meta');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 7);
  } finally { db.comTenant = old; }
});
