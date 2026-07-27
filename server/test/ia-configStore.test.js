'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { criptografar } = require('../ia/crypto');
const store = require('../ia/iaConfigStore');
const SEG = 'segredo-de-teste-com-mais-de-32-chars-1234567890';
process.env.JWT_SECRET = SEG;
const TENANT_A = 1;
const TENANT_B = 2;

test('carrega a config ativa e decifra a chave', async () => {
  store.invalidar();
  const cifrada = criptografar('sk-123', TENANT_A);
  const conn = { async execute() { return { rows: [{ PROVIDER: 'openai', MODELO: 'gpt-4o', BASE_URL: 'https://api.openai.com/v1', API_KEY_CRIPTOGRAFADA: cifrada }] }; } };
  const cfg = await store.carregar(conn, TENANT_A);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-123');
});

test('sem linha ativa devolve null', async () => {
  store.invalidar();
  const conn = { async execute() { return { rows: [] }; } };
  assert.equal(await store.carregar(conn, TENANT_A), null);
});

test('toda query filtra por tenant_id (bind explícito)', async () => {
  store.invalidar();
  let bindsVistos;
  const conn = { async execute(_sql, binds) { bindsVistos = binds; return { rows: [] }; } };
  await store.carregar(conn, TENANT_A);
  assert.equal(bindsVistos.tenantId, TENANT_A);
});

test('SEGURANÇA: cache é por tenant — config do A não vaza pro B', async () => {
  store.invalidar();
  // Fake conn que simula a RLS: só devolve a linha se o tenantId no bind bater
  // com o "dono" da linha — assim provamos que store.carregar sempre manda o
  // tenantId certo e nunca serve do cache de outro tenant.
  const cifradaA = criptografar('sk-do-A', TENANT_A);
  const cifradaB = criptografar('sk-do-B', TENANT_B);
  const conn = {
    async execute(_sql, binds) {
      if (String(binds.tenantId) === String(TENANT_A)) {
        return { rows: [{ PROVIDER: 'openai', MODELO: 'a', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaA }] };
      }
      if (String(binds.tenantId) === String(TENANT_B)) {
        return { rows: [{ PROVIDER: 'anthropic', MODELO: 'b', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaB }] };
      }
      return { rows: [] };
    },
  };
  const cfgA = await store.carregar(conn, TENANT_A);
  const cfgB = await store.carregar(conn, TENANT_B);
  assert.equal(cfgA.apiKey, 'sk-do-A');
  assert.equal(cfgB.apiKey, 'sk-do-B');
  assert.notEqual(cfgA.provider, cfgB.provider);

  // invalidar(TENANT_A) não pode afetar o cache do B.
  store.invalidar(TENANT_A);
  const cfgBdenovo = await store.carregar(conn, TENANT_B);
  assert.equal(cfgBdenovo.apiKey, 'sk-do-B');
});
