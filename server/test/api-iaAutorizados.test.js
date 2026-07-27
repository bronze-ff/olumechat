'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');

function app(tenantId = 1) {
  const a = express(); a.use(express.json());
  a.use((req, _r, n) => { req.user = { matricula: 10 }; req.perfil = { atendenteId: 1, papel: 'ADMIN' }; req.tenantId = tenantId; n(); });
  a.use('/api/ia-autorizados', require('../api/iaAutorizados')); return a;
}
function call(a, metodo, caminho, corpo) {
  return new Promise((resolve) => { const s = a.listen(0, () => { const p = s.address().port;
    const r = http.request({ port: p, path: caminho, method: metodo, headers: { 'content-type': 'application/json' } }, (res) => {
      let d=''; res.on('data', c => d+=c); res.on('end', () => { s.close(); resolve({ status: res.statusCode, body: d?JSON.parse(d):null }); }); });
    if (corpo) r.write(JSON.stringify(corpo)); r.end(); }); });
}

test('POST insere/ativa telefone autorizado e audita', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, b){ cap.push({sql,b}); return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await call(app(), 'POST', '/api/ia-autorizados', { telefone: '5562999990000', nome: 'Diretor', numeroId: 2 });
  assert.equal(res.status, 200);
  const upsert = cap.find(c => c.sql.includes('INSERT INTO ia_autorizado') && c.sql.includes('ON CONFLICT'));
  assert.ok(upsert);
  assert.equal(upsert.b.tenantId, 1);
  assert.ok(cap.some(c => c.sql.includes('auditoria')));
});

test('POST normaliza o telefone com DDI 55 antes de gravar', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, b){ cap.push({sql,b}); return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await call(app(), 'POST', '/api/ia-autorizados', { telefone: '62983423192', numeroId: 2 });
  assert.equal(res.status, 200);
  const upsert = cap.find(c => c.sql.includes('INSERT INTO ia_autorizado') && c.sql.includes('ON CONFLICT'));
  assert.equal(upsert.b.t, '5562983423192'); // ganhou o DDI 55
});

test('POST sem telefone dá 400', async () => {
  db.getConnection = async () => ({ async execute(){ return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await call(app(), 'POST', '/api/ia-autorizados', { numeroId: 2 });
  assert.equal(res.status, 400);
});

test('GET filtra por tenant_id (bind explícito)', async () => {
  let bindsVistos;
  db.getConnection = async () => ({ async execute(sql, b) { bindsVistos = b; return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  await call(app(9), 'GET', '/api/ia-autorizados');
  assert.equal(bindsVistos.tenantId, 9);
});

test('DELETE filtra por tenant_id (bind explícito)', async () => {
  let bindsVistos;
  db.getConnection = async () => ({ async execute(sql, b) { if (sql.startsWith('UPDATE')) bindsVistos = b; return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await call(app(9), 'DELETE', '/api/ia-autorizados/5');
  assert.equal(res.status, 200);
  assert.equal(bindsVistos.tenantId, 9);
});

test('SEGURANÇA: telefone autorizado pelo tenant A não é alterado por um DELETE do tenant B', async () => {
  // Fake conn simula a RLS: UPDATE só afeta a linha se o tenant_id do bind bater.
  const linhas = [{ id: 5, tenant_id: 1, ativo: 'S' }];
  db.getConnection = async () => ({
    async execute(sql, b) {
      if (sql.startsWith('UPDATE')) {
        const linha = linhas.find((l) => l.id === b.id && l.tenant_id === b.tenantId);
        if (linha) linha.ativo = 'N';
        return { rows: [], rowsAffected: linha ? 1 : 0 };
      }
      return { rows: [] };
    }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{},
  });
  await call(app(2), 'DELETE', '/api/ia-autorizados/5'); // tenant B tenta desativar linha do tenant A
  assert.equal(linhas[0].ativo, 'S', 'tenant B desativou telefone autorizado do tenant A — VAZAMENTO');
});
