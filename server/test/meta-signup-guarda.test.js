// Teste do guard de papel em api/meta.js (B9 — achado mais grave do lote).
// POST /signup/exchange trocava o code do Embedded Signup e sobrescrevia o
// `numero` do tenant (UPSERT por phone_number_id) sem NENHUMA guarda de papel
// além de authMiddleware/anexarPerfil — qualquer ATENDENTE autenticado podia
// sequestrar o canal oficial do WhatsApp chamando a API direto. Mesmo padrão
// de numeros.js::exigirSuporteOperador: só a sessão de suporte do operador.
// GET /status também passa a exigir ADMIN/SUPERVISOR/AUDITOR (expõe
// waba_id/qualidade do número, não é dado de atendimento comum).
'use strict';

process.env.META_APP_SECRET = 'app-secret-test';
process.env.META_APP_ID = 'app-id-test';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { router } = require('../api/meta');

function app({ papel, suporte } = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.tenantId = 1;
    req.user = suporte ? { suporte: true } : { matricula: 10 };
    req.perfil = { atendenteId: 1, papel: papel || 'ATENDENTE' };
    next();
  });
  a.use('/api/meta', router);
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

const BODY = { code: 'abc', phoneNumberId: 'PN-1' };

test('POST /signup/exchange: ATENDENTE recebe 403 (não é sessão de suporte)', async () => {
  const r = await req(app({ papel: 'ATENDENTE' }), 'POST', '/api/meta/signup/exchange', BODY);
  assert.equal(r.status, 403);
});

test('POST /signup/exchange: SUPERVISOR recebe 403 (não é sessão de suporte)', async () => {
  const r = await req(app({ papel: 'SUPERVISOR' }), 'POST', '/api/meta/signup/exchange', BODY);
  assert.equal(r.status, 403);
});

test('POST /signup/exchange: ADMIN comum (sem sessão de suporte) TAMBÉM recebe 403', async () => {
  const r = await req(app({ papel: 'ADMIN' }), 'POST', '/api/meta/signup/exchange', BODY);
  assert.equal(r.status, 403);
});

test('GET /status: ATENDENTE recebe 403 (não é leitura de gestão)', async () => {
  const r = await req(app({ papel: 'ATENDENTE' }), 'GET', '/api/meta/status');
  assert.equal(r.status, 403);
});

test('GET /status: SUPERVISOR passa da guarda de papel (não trava em 403)', async () => {
  const conn = { async execute() { return { rows: [] }; } };
  const db = require('../db/pool');
  const old = db.comTenant;
  db.comTenant = async (_t, fn) => fn(conn);
  try {
    const r = await req(app({ papel: 'SUPERVISOR' }), 'GET', '/api/meta/status');
    assert.equal(r.status, 200);
  } finally { db.comTenant = old; }
});
