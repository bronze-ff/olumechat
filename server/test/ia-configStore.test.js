'use strict';
// ia/iaConfigStore.js — resolve a credencial ativa de um tenant. FIL-78:
// prioridade é a chave PRÓPRIA do tenant (ia_config, legado); sem ela, cai
// para a credencial GLOBAL do operador (provedor_credencial), lida via
// operador/credencialIa.js (própria transação comOperador — NUNCA a `conn`
// do tenant, que não tem privilégio nenhum sobre provedor_credencial).
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x';
const test = require('node:test');
const assert = require('node:assert');
const { criptografar } = require('../ia/crypto');
const { cifrar } = require('../ia/credencialOperador');
const db = require('../db/pool');
const store = require('../ia/iaConfigStore');
const SEG = 'segredo-de-teste-com-mais-de-32-chars-1234567890';
process.env.JWT_SECRET = SEG;
const TENANT_A = 1;
const TENANT_B = 2;

/** Conexão de operador (comOperador) para a credencial GLOBAL. */
function connGlobal(credenciais = []) {
  return {
    async execute(sql) {
      if (/SELECT provider, modelo_padrao, base_url, api_key_criptografada FROM provedor_credencial WHERE ativo = 'S'/i.test(sql)) {
        const ativa = credenciais.find((c) => c.ATIVO === 'S');
        return { rows: ativa ? [ativa] : [] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}
/** Sem credencial global nenhuma (tabela vazia/migração não aplicada). */
function semGlobal() { return connGlobal([]); }

test('carrega a config PRÓPRIA do tenant e decifra a chave', async () => {
  store.invalidar(); store.invalidarGlobal();
  db.getConnection = async () => semGlobal();
  const cifrada = criptografar('sk-123', TENANT_A);
  const conn = { async execute() { return { rows: [{ PROVIDER: 'openai', MODELO: 'gpt-4o', BASE_URL: 'https://api.openai.com/v1', API_KEY_CRIPTOGRAFADA: cifrada }] }; } };
  const cfg = await store.carregar(conn, TENANT_A);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-123');
});

test('sem config própria e sem credencial global, devolve null', async () => {
  store.invalidar(); store.invalidarGlobal();
  db.getConnection = async () => semGlobal();
  const conn = { async execute() { return { rows: [] }; } };
  assert.equal(await store.carregar(conn, TENANT_A), null);
});

test('FIL-78: sem config própria, cai para a credencial GLOBAL do operador', async () => {
  store.invalidar(); store.invalidarGlobal();
  const cifradaGlobal = cifrar('sk-do-operador');
  db.getConnection = async () => connGlobal([{
    PROVIDER: 'openrouter', MODELO_PADRAO: 'openai/gpt-4o-mini', BASE_URL: 'https://openrouter.ai/api/v1',
    API_KEY_CRIPTOGRAFADA: cifradaGlobal, ATIVO: 'S',
  }]);
  const conn = { async execute() { return { rows: [] }; } }; // tenant sem ia_config
  const cfg = await store.carregar(conn, TENANT_A);
  assert.equal(cfg.provider, 'openrouter');
  assert.equal(cfg.apiKey, 'sk-do-operador');
});

test('FIL-78: config PRÓPRIA do tenant tem prioridade sobre a credencial global', async () => {
  store.invalidar(); store.invalidarGlobal();
  const cifradaGlobal = cifrar('sk-do-operador');
  db.getConnection = async () => connGlobal([{
    PROVIDER: 'openrouter', MODELO_PADRAO: 'x', BASE_URL: 'u', API_KEY_CRIPTOGRAFADA: cifradaGlobal, ATIVO: 'S',
  }]);
  const cifradaTenant = criptografar('sk-do-tenant', TENANT_A);
  const conn = { async execute() { return { rows: [{ PROVIDER: 'anthropic', MODELO: 'claude-sonnet-5', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaTenant }] }; } };
  const cfg = await store.carregar(conn, TENANT_A);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.apiKey, 'sk-do-tenant');
});

test('toda consulta à config do tenant filtra por tenant_id (bind explícito)', async () => {
  store.invalidar(); store.invalidarGlobal();
  db.getConnection = async () => semGlobal();
  let bindsVistos;
  const conn = { async execute(sql, binds) {
    if (sql.includes('FROM ia_config')) bindsVistos = binds;
    return { rows: [] };
  } };
  await store.carregar(conn, TENANT_A);
  assert.equal(bindsVistos.tenantId, TENANT_A);
});

test('SEGURANÇA: cache é por tenant — config própria do A não vaza pro B', async () => {
  store.invalidar(); store.invalidarGlobal();
  db.getConnection = async () => semGlobal();
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

test('SEGURANÇA: dois tenants sem chave própria compartilham a MESMA credencial global (é o objetivo do FIL-78)', async () => {
  store.invalidar(); store.invalidarGlobal();
  const cifradaGlobal = cifrar('sk-compartilhada');
  db.getConnection = async () => connGlobal([{
    PROVIDER: 'anthropic', MODELO_PADRAO: 'claude-sonnet-5', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaGlobal, ATIVO: 'S',
  }]);
  const semConfigPropria = { async execute() { return { rows: [] }; } };
  const cfgA = await store.carregar(semConfigPropria, TENANT_A);
  const cfgB = await store.carregar(semConfigPropria, TENANT_B);
  assert.equal(cfgA.apiKey, 'sk-compartilhada');
  assert.equal(cfgB.apiKey, 'sk-compartilhada');
});

test('invalidarGlobal() força nova leitura da credencial do operador', async () => {
  store.invalidar(); store.invalidarGlobal();
  const TENANT_X = 91, TENANT_Y = 92, TENANT_Z = 93; // tenants exclusivos deste teste
  let chamadasGlobais = 0;
  db.getConnection = async () => {
    chamadasGlobais += 1;
    return connGlobal([{ PROVIDER: 'anthropic', MODELO_PADRAO: 'm', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifrar('sk-1'), ATIVO: 'S' }]);
  };
  const semConfigPropria = { async execute() { return { rows: [] }; } };

  await store.carregar(semConfigPropria, TENANT_X); // miss: cache do tenant E do global vazios
  assert.equal(chamadasGlobais, 1);

  await store.carregar(semConfigPropria, TENANT_Y); // miss no tenant, mas HIT no cache global
  assert.equal(chamadasGlobais, 1, 'cache global (TTL 60s) evita nova leitura pro segundo tenant');

  store.invalidarGlobal();
  await store.carregar(semConfigPropria, TENANT_Z); // tenant novo, cache global agora vazio
  assert.equal(chamadasGlobais, 2, 'invalidarGlobal() força nova leitura da credencial do operador');
});
