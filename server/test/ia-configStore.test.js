'use strict';
// ia/iaConfigStore.js — resolve a credencial ativa de um tenant. FIL-78:
// prioridade é a chave PRÓPRIA do tenant (ia_config, legado); sem ela, cai
// para a credencial GLOBAL do operador (provedor_credencial).
//
// carregar(tenantId) NÃO recebe `conn` — resolve tudo (chave própria E
// credencial global) NUMA ÚNICA transação de operador (comOperador,
// BYPASSRLS, tenant_id sempre explícito), pra nunca segurar duas conexões do
// pool ao mesmo tempo (achado de review do FIL-78 — ver
// test/ia-sem-conexao-aninhada.test.js para a prova disso). Por isso, aqui,
// tudo passa por `db.getConnection`.
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

/** Conexão de operador: responde ia_config (chave própria) e
 *  provedor_credencial (global) pelo texto da query. */
function conexao({ propria = null, global = null } = {}) {
  return {
    async execute(sql) {
      if (/FROM ia_config/.test(sql)) return { rows: propria ? [propria] : [] };
      if (/FROM provedor_credencial WHERE ativo = 'S'/.test(sql)) return { rows: global ? [global] : [] };
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('carrega a config PRÓPRIA do tenant e decifra a chave', async () => {
  store.invalidar(); store.invalidarGlobal();
  const cifrada = criptografar('sk-123', TENANT_A);
  db.getConnection = async () => conexao({
    propria: { PROVIDER: 'openai', MODELO: 'gpt-4o', BASE_URL: 'https://api.openai.com/v1', API_KEY_CRIPTOGRAFADA: cifrada },
  });
  const cfg = await store.carregar(TENANT_A);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-123');
});

test('sem config própria e sem credencial global, devolve null', async () => {
  store.invalidar(); store.invalidarGlobal();
  db.getConnection = async () => conexao();
  assert.equal(await store.carregar(TENANT_A), null);
});

test('FIL-78: sem config própria, cai para a credencial GLOBAL do operador', async () => {
  store.invalidar(); store.invalidarGlobal();
  const cifradaGlobal = cifrar('sk-do-operador');
  db.getConnection = async () => conexao({
    global: { PROVIDER: 'openrouter', MODELO_PADRAO: 'openai/gpt-4o-mini', BASE_URL: 'https://openrouter.ai/api/v1', API_KEY_CRIPTOGRAFADA: cifradaGlobal },
  });
  const cfg = await store.carregar(TENANT_A);
  assert.equal(cfg.provider, 'openrouter');
  assert.equal(cfg.apiKey, 'sk-do-operador');
});

test('FIL-78: config PRÓPRIA do tenant tem prioridade sobre a credencial global', async () => {
  store.invalidar(); store.invalidarGlobal();
  const cifradaTenant = criptografar('sk-do-tenant', TENANT_A);
  const cifradaGlobal = cifrar('sk-do-operador');
  db.getConnection = async () => conexao({
    propria: { PROVIDER: 'anthropic', MODELO: 'claude-sonnet-5', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaTenant },
    global: { PROVIDER: 'openrouter', MODELO_PADRAO: 'x', BASE_URL: 'u', API_KEY_CRIPTOGRAFADA: cifradaGlobal },
  });
  const cfg = await store.carregar(TENANT_A);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.apiKey, 'sk-do-tenant');
});

test('toda consulta à config do tenant filtra por tenant_id (bind explícito)', async () => {
  store.invalidar(); store.invalidarGlobal();
  let bindsVistos;
  db.getConnection = async () => ({
    async execute(sql, binds) {
      if (sql.includes('FROM ia_config')) bindsVistos = binds;
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  });
  await store.carregar(TENANT_A);
  assert.equal(bindsVistos.tenantId, TENANT_A);
});

test('SEGURANÇA: cache é por tenant — config própria do A não vaza pro B', async () => {
  store.invalidar(); store.invalidarGlobal();
  // Fake conn que simula a RLS: só devolve a linha se o tenantId no bind bater
  // com o "dono" da linha — assim provamos que store.carregar sempre manda o
  // tenantId certo e nunca serve do cache de outro tenant.
  const cifradaA = criptografar('sk-do-A', TENANT_A);
  const cifradaB = criptografar('sk-do-B', TENANT_B);
  db.getConnection = async () => ({
    async execute(sql, binds) {
      if (!/FROM ia_config/.test(sql)) return { rows: [] };
      if (String(binds.tenantId) === String(TENANT_A)) {
        return { rows: [{ PROVIDER: 'openai', MODELO: 'a', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaA }] };
      }
      if (String(binds.tenantId) === String(TENANT_B)) {
        return { rows: [{ PROVIDER: 'anthropic', MODELO: 'b', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaB }] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  });
  const cfgA = await store.carregar(TENANT_A);
  const cfgB = await store.carregar(TENANT_B);
  assert.equal(cfgA.apiKey, 'sk-do-A');
  assert.equal(cfgB.apiKey, 'sk-do-B');
  assert.notEqual(cfgA.provider, cfgB.provider);

  // invalidar(TENANT_A) não pode afetar o cache do B.
  store.invalidar(TENANT_A);
  const cfgBdenovo = await store.carregar(TENANT_B);
  assert.equal(cfgBdenovo.apiKey, 'sk-do-B');
});

test('SEGURANÇA: dois tenants sem chave própria compartilham a MESMA credencial global (é o objetivo do FIL-78)', async () => {
  store.invalidar(); store.invalidarGlobal();
  const cifradaGlobal = cifrar('sk-compartilhada');
  db.getConnection = async () => conexao({
    global: { PROVIDER: 'anthropic', MODELO_PADRAO: 'claude-sonnet-5', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaGlobal },
  });
  const cfgA = await store.carregar(TENANT_A);
  const cfgB = await store.carregar(TENANT_B);
  assert.equal(cfgA.apiKey, 'sk-compartilhada');
  assert.equal(cfgB.apiKey, 'sk-compartilhada');
});

test('invalidarGlobal() força nova leitura da credencial do operador', async () => {
  store.invalidar(); store.invalidarGlobal();
  const TENANT_X = 91, TENANT_Y = 92, TENANT_Z = 93; // tenants exclusivos deste teste
  // Cada tenant abre a SUA PRÓPRIA conexão de operador (precisa checar a
  // config PRÓPRIA daquele tenant de qualquer forma) — o que o cache global
  // evita é reconsultar `provedor_credencial`, não a conexão em si.
  let consultasAoGlobal = 0;
  db.getConnection = async () => {
    const conn = conexao({ global: { PROVIDER: 'anthropic', MODELO_PADRAO: 'm', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifrar('sk-1') } });
    const executeOriginal = conn.execute.bind(conn);
    conn.execute = async (sql, binds) => {
      if (/FROM provedor_credencial WHERE ativo = 'S'/.test(sql)) consultasAoGlobal += 1;
      return executeOriginal(sql, binds);
    };
    return conn;
  };

  await store.carregar(TENANT_X); // miss: cache do tenant E do global vazios
  assert.equal(consultasAoGlobal, 1);

  await store.carregar(TENANT_Y); // miss no tenant, mas HIT no cache global
  assert.equal(consultasAoGlobal, 1, 'cache global (TTL 60s) evita reconsultar provedor_credencial pro segundo tenant');

  store.invalidarGlobal();
  await store.carregar(TENANT_Z); // tenant novo, cache global agora vazio
  assert.equal(consultasAoGlobal, 2, 'invalidarGlobal() força nova leitura da credencial do operador');
});

test('FIL-76: invalidarGlobal() evicta também a entrada do TENANT que já tinha caído no fallback global', async () => {
  // Achado de review: invalidarGlobal() só apagava CHAVE_GLOBAL — um tenant
  // sem chave própria que já tinha resolvido (e cacheado, por tenantId) a
  // credencial global continuava servindo a chave VELHA por até 60s depois
  // de o operador rotacionar, mesmo chamando invalidarGlobal() explicitamente
  // na rota (operador/routes.js::PUT /ia-credencial).
  store.invalidar(); store.invalidarGlobal();
  const TENANT_Q = 95;
  let versaoGlobal = 'sk-antiga';
  db.getConnection = async () => conexao({
    global: { PROVIDER: 'anthropic', MODELO_PADRAO: 'm', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifrar(versaoGlobal) },
  });

  const antes = await store.carregar(TENANT_Q);
  assert.equal(antes.apiKey, 'sk-antiga');

  versaoGlobal = 'sk-nova'; // o operador rotacionou a credencial
  store.invalidarGlobal();

  const depois = await store.carregar(TENANT_Q); // MESMO tenant, TTL dele ainda não tinha expirado
  assert.equal(depois.apiKey, 'sk-nova', 'não pode continuar servindo a chave velha da própria entrada do tenant');
});

test('invalidarGlobal() NÃO evicta tenant com chave PRÓPRIA (nunca veio do fallback global)', async () => {
  store.invalidar(); store.invalidarGlobal();
  const cifradaTenant = criptografar('sk-do-tenant-fixa', TENANT_A);
  let consultasIaConfig = 0;
  db.getConnection = async () => {
    const conn = conexao({ propria: { PROVIDER: 'anthropic', MODELO: 'm', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifradaTenant } });
    const executeOriginal = conn.execute.bind(conn);
    conn.execute = async (sql, binds) => { if (/FROM ia_config/.test(sql)) consultasIaConfig += 1; return executeOriginal(sql, binds); };
    return conn;
  };
  await store.carregar(TENANT_A);
  assert.equal(consultasIaConfig, 1);

  store.invalidarGlobal();
  const cfg = await store.carregar(TENANT_A); // ainda dentro do TTL do tenant — não devia reconsultar
  assert.equal(consultasIaConfig, 1, 'chave própria não é "deGlobal" — invalidarGlobal() não deveria evictar essa entrada');
  assert.equal(cfg.apiKey, 'sk-do-tenant-fixa');
});
