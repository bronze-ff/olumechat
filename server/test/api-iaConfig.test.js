'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
// api/iaConfig.js hoje é SOMENTE LEITURA: quem define provider/modelo/chave é o
// operador (ver operador-ia-config.test.js) — o admin do tenant só vê status
// (`habilitada` + provider/modelo em uso, nunca a chave).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');

function servidor(papel = 'ADMIN', tenantId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { matricula: 10 }; req.perfil = { atendenteId: 1, papel }; req.tenantId = tenantId; next(); });
  app.use('/api/ia-config', require('../api/iaConfig'));
  return app;
}
function req(app, metodo = 'GET') {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = srv.address().port;
      const r = http.request({ port, path: '/api/ia-config', method: metodo, headers: { 'content-type': 'application/json' } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
          srv.close();
          let body = null; try { body = d ? JSON.parse(d) : null; } catch { /* 404 default do Express não é JSON */ }
          resolve({ status: res.statusCode, body });
        });
      });
      r.end();
    });
  });
}

test('GET devolve habilitada + provider/modelo, nunca a chave', async () => {
  db.getConnection = async () => ({ async execute(sql) {
    if (sql.includes('FROM tenant')) return { rows: [{ IA_HABILITADA: 'S' }] };
    return { rows: [{ PROVIDER: 'openai', MODELO: 'gpt-4o', BASE_URL: 'u', ATIVO: 'S' }] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor());
  assert.equal(res.body.habilitada, true);
  assert.equal(res.body.provider, 'openai');
  assert.ok(!('apiKey' in res.body) && !('API_KEY_CRIPTOGRAFADA' in res.body));
});

test('GET sem plano de IA: habilitada=false mesmo com ia_config ainda salvo', async () => {
  db.getConnection = async () => ({ async execute(sql) {
    if (sql.includes('FROM tenant')) return { rows: [{ IA_HABILITADA: 'N' }] };
    return { rows: [{ PROVIDER: 'openai', MODELO: 'gpt-4o', BASE_URL: 'u', ATIVO: 'S' }] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor());
  assert.equal(res.body.habilitada, false);
});

test('GET sem ia_config nenhum: responde vazio, não quebra', async () => {
  db.getConnection = async () => ({ async execute(sql) {
    if (sql.includes('FROM tenant')) return { rows: [{ IA_HABILITADA: 'N' }] };
    return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor());
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, null);
  assert.equal(res.body.ativo, false);
});

test('SEGURANÇA: GET só devolve a config do tenant do próprio request (bind de tenant_id)', async () => {
  let bindsVistos;
  db.getConnection = async () => ({ async execute(sql, binds) {
    if (sql.includes('FROM tenant')) return { rows: [{ IA_HABILITADA: 'S' }] };
    bindsVistos = binds;
    return { rows: [{ PROVIDER: 'openai', MODELO: 'm', BASE_URL: null, ATIVO: 'S' }] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  await req(servidor('ADMIN', 7));
  assert.equal(bindsVistos.tenantId, 7);
});

test('não existe mais PUT nesta rota — configurar é só via painel do operador', async () => {
  db.getConnection = async () => ({ async execute() { return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'PUT');
  assert.equal(res.status, 404);
});
