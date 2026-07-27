'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');

function app() {
  const a = express(); a.use(express.json());
  a.use((req, _r, n) => { req.user = { matricula: 10 }; req.perfil = { atendenteId: 1, papel: 'ADMIN' }; n(); });
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
  assert.ok(cap.some(c => c.sql.includes('MERGE INTO MC_ZAP_IA_AUTORIZADO')));
  assert.ok(cap.some(c => c.sql.includes('MC_ZAP_AUDITORIA')));
});

test('POST normaliza o telefone com DDI 55 antes de gravar', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, b){ cap.push({sql,b}); return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await call(app(), 'POST', '/api/ia-autorizados', { telefone: '62983423192', numeroId: 2 });
  assert.equal(res.status, 200);
  const merge = cap.find(c => c.sql.includes('MERGE INTO MC_ZAP_IA_AUTORIZADO'));
  assert.equal(merge.b.t, '5562983423192'); // ganhou o DDI 55
});

test('POST sem telefone dá 400', async () => {
  db.getConnection = async () => ({ async execute(){ return { rows: [] }; }, close: async()=>{} });
  const res = await call(app(), 'POST', '/api/ia-autorizados', { numeroId: 2 });
  assert.equal(res.status, 400);
});
