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
const iaConfigStore = require('../ia/iaConfigStore');
const { cifrar } = require('../ia/credencialOperador');

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

// ---------------------------------------------------------------------------
// FIL-78 (achado de review, P1): sem chave própria, o status precisa
// reconhecer a credencial GLOBAL do operador — sem nunca expor detalhe dela.
// Tenant exclusivo (55501) pra não colidir com o cache do iaConfigStore de
// outros arquivos da suíte, que também usam tenantId pequenos.
// ---------------------------------------------------------------------------
const TENANT_GLOBAL = 55501;

test('FIL-78: sem chave própria, mas COM credencial global ativa → ativo=true, origem=operador, SEM detalhe nenhum', async () => {
  iaConfigStore.invalidar(TENANT_GLOBAL); iaConfigStore.invalidarGlobal();
  db.getConnection = async () => ({
    async execute(sql) {
      if (sql.includes('FROM tenant')) return { rows: [{ IA_HABILITADA: 'S' }] };
      if (sql.includes('FROM ia_config')) return { rows: [] }; // sem chave própria
      if (sql.includes('FROM provedor_credencial WHERE ativo')) {
        return { rows: [{ PROVIDER: 'openrouter', MODELO_PADRAO: 'openai/gpt-4o-mini', BASE_URL: 'https://openrouter.ai/api/v1', API_KEY_CRIPTOGRAFADA: cifrar('sk-global-secreta') }] };
      }
      return { rows: [] };
    },
    commit: async()=>{}, rollback: async()=>{}, close: async()=>{},
  });
  const res = await req(servidor('ADMIN', TENANT_GLOBAL));
  assert.equal(res.status, 200);
  assert.equal(res.body.habilitada, true);
  assert.equal(res.body.ativo, true, 'a IA está de fato configurada (via credencial global) — não pode dizer "não configurado"');
  assert.equal(res.body.origem, 'operador');
  assert.equal(res.body.provider, null, 'credencial global não expõe provider por rota de tenant');
  assert.equal(res.body.modelo, null);
  assert.equal(res.body.baseUrl, null);
  assert.equal(res.body.atualizadoEm, null);
  assert.ok(!JSON.stringify(res.body).includes('sk-global-secreta'), 'a chave nunca aparece na resposta');
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('openrouter'), 'nem o nome do provedor global aparece na resposta');
});

test('FIL-78: sem chave própria e sem credencial global → ativo=false, origem=null', async () => {
  const TENANT_SEM_NADA = 55502;
  iaConfigStore.invalidar(TENANT_SEM_NADA); iaConfigStore.invalidarGlobal();
  db.getConnection = async () => ({
    async execute(sql) {
      if (sql.includes('FROM tenant')) return { rows: [{ IA_HABILITADA: 'S' }] };
      return { rows: [] }; // nem ia_config nem provedor_credencial têm linha
    },
    commit: async()=>{}, rollback: async()=>{}, close: async()=>{},
  });
  const res = await req(servidor('ADMIN', TENANT_SEM_NADA));
  assert.equal(res.status, 200);
  assert.equal(res.body.habilitada, true);
  assert.equal(res.body.ativo, false);
  assert.equal(res.body.origem, null);
});

test('FIL-78: com chave PRÓPRIA ativa, origem=tenant e o global nem é consultado', async () => {
  const TENANT_PROPRIA = 55503;
  iaConfigStore.invalidar(TENANT_PROPRIA); iaConfigStore.invalidarGlobal();
  let consultouGlobal = false;
  db.getConnection = async () => ({
    async execute(sql) {
      if (sql.includes('FROM tenant')) return { rows: [{ IA_HABILITADA: 'S' }] };
      if (sql.includes('FROM provedor_credencial')) consultouGlobal = true;
      if (sql.includes('FROM ia_config')) return { rows: [{ PROVIDER: 'anthropic', MODELO: 'claude-sonnet-5', BASE_URL: null, ATIVO: 'S', ATUALIZADO_EM: new Date() }] };
      return { rows: [] };
    },
    commit: async()=>{}, rollback: async()=>{}, close: async()=>{},
  });
  const res = await req(servidor('ADMIN', TENANT_PROPRIA));
  assert.equal(res.status, 200);
  assert.equal(res.body.origem, 'tenant');
  assert.equal(res.body.provider, 'anthropic');
  assert.equal(consultouGlobal, false, 'com chave própria ativa, nem precisa consultar a credencial global');
});
