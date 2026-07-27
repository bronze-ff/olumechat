'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/pool');

function servidor(papel = 'ADMIN') {
  const app = express();
  app.use(express.json());
  // stub de auth/perfil com papel configurável
  app.use((req, _res, next) => { req.user = { matricula: 10 }; req.perfil = { atendenteId: 1, papel }; next(); });
  app.use('/api/ia-config', require('../api/iaConfig'));
  return app;
}
function req(app, metodo, corpo) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = srv.address().port;
      const r = http.request({ port, path: '/api/ia-config', method: metodo, headers: { 'content-type': 'application/json' } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }); });
      });
      if (corpo) r.write(JSON.stringify(corpo)); r.end();
    });
  });
}

test('PUT válido cifra a chave, faz upsert e audita', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, binds) { cap.push({ sql, binds }); return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'PUT', { provider: 'openai', modelo: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abc' });
  assert.equal(res.status, 200);
  const merge = cap.find((c) => c.sql.includes('MERGE INTO MC_ZAP_IA_CONFIG'));
  assert.ok(merge, 'faz upsert');
  assert.ok(!JSON.stringify(cap).includes('sk-abc'), 'a chave nunca vai em claro pro banco');
  assert.ok(cap.some((c) => c.sql.includes('MC_ZAP_AUDITORIA')), 'audita');
});

test('PUT rejeita provider inválido', async () => {
  db.getConnection = async () => ({ async execute() { return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'PUT', { provider: 'zzz', modelo: 'x', apiKey: 'k' });
  assert.equal(res.status, 400);
});

test('GET nunca devolve a API key', async () => {
  db.getConnection = async () => ({ async execute() { return { rows: [{ PROVIDER: 'openai', MODELO: 'gpt-4o', BASE_URL: 'u', ATIVO: 'S' }] }; }, close: async()=>{} });
  const res = await req(servidor(), 'GET');
  assert.equal(res.body.provider, 'openai');
  assert.ok(!('apiKey' in res.body) && !('API_KEY_CRIPTOGRAFADA' in res.body));
});

test('PUT com papel não-ADMIN retorna 403', async () => {
  db.getConnection = async () => ({ async execute() { return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor('ATENDENTE'), 'PUT', { provider: 'openai', modelo: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abc' });
  assert.equal(res.status, 403);
});

test('PUT sem apiKey MANTÉM a chave atual (editar só modelo/URL sem recolar a chave)', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, binds) {
    cap.push({ sql, binds });
    if (sql.includes('SELECT API_KEY_CRIPTOGRAFADA')) return { rows: [{ API_KEY_CRIPTOGRAFADA: 'iv:tag:ct' }] };
    return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'PUT', { provider: 'openrouter', modelo: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' }); // sem apiKey
  assert.equal(res.status, 200);
  const merge = cap.find((c) => c.sql.includes('MERGE INTO MC_ZAP_IA_CONFIG'));
  assert.equal(merge.binds.k, 'iv:tag:ct'); // reusou a chave já cifrada
});

test('PUT rejeita modelo que é URL (causa do "not a valid model ID")', async () => {
  db.getConnection = async () => ({ async execute() { return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'PUT', { provider: 'openrouter', modelo: 'https://openrouter.ai/nvidia/x:free', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /URL/i);
});

test('PUT rejeita baseUrl inválida e normaliza um /chat/completions colado por engano', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, binds) { cap.push({ sql, binds }); return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const bad = await req(servidor(), 'PUT', { provider: 'openrouter', modelo: 'm', baseUrl: 'não é url', apiKey: 'k' });
  assert.equal(bad.status, 400);
  const ok = await req(servidor(), 'PUT', { provider: 'openrouter', modelo: 'm', baseUrl: 'https://openrouter.ai/api/v1/chat/completions/', apiKey: 'k' });
  assert.equal(ok.status, 200);
  const merge = cap.find((c) => c.sql.includes('MERGE INTO MC_ZAP_IA_CONFIG'));
  assert.equal(merge.binds.b, 'https://openrouter.ai/api/v1'); // normalizada
});
