'use strict';
// operador/tenants.js::salvarIaConfig + definirIa — IA é add-on vendido à
// parte: só o operador grava provider/modelo/chave de um cliente (rota
// /api/operador/tenants/:id/ia-config) e só ele liga/desliga o plano
// (/api/operador/tenants/:id/ia). Mesma validação que o antigo PUT do painel
// do cliente tinha (api-iaConfig.test.js, hoje só GET).
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const tenants = require('../operador/tenants');

const OPERADOR = { id: 1, email: 'op@olume.com' };

/** comOperador roda tudo numa "transação" via db.getConnection — não passa
    por RLS de verdade (bypassrls), então o fake só precisa devolver linhas
    plausíveis e registrar o que foi executado. */
function conexao({ tenant = { ID: 5, NOME: 'Cliente X', SLUG: 'cliente-x', STATUS: 'ativo' }, chaveExistente = null, ativoIaConfig = null } = {}) {
  const cap = [];
  return { cap, async execute(sql, binds = {}) {
    cap.push({ sql, binds });
    if (/SELECT id, nome, slug, status FROM tenant WHERE id = :id/i.test(sql)) {
      return tenant ? { rows: [tenant] } : { rows: [] };
    }
    if (/SELECT ativo FROM ia_config/i.test(sql)) {
      return { rows: ativoIaConfig ? [{ ATIVO: ativoIaConfig }] : [] };
    }
    if (/SELECT api_key_criptografada FROM ia_config/i.test(sql)) {
      return { rows: chaveExistente ? [{ API_KEY_CRIPTOGRAFADA: chaveExistente }] : [] };
    }
    return { rows: [] };
  }, commit: async () => {}, rollback: async () => {}, close: async () => {} };
}

test('salvarIaConfig rejeita provider inválido', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    tenants.salvarIaConfig({ operador: OPERADOR, tenantId: 5, provider: 'zzz', modelo: 'x', apiKey: 'k' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarIaConfig rejeita modelo que é URL', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    tenants.salvarIaConfig({ operador: OPERADOR, tenantId: 5, provider: 'openrouter', modelo: 'https://openrouter.ai/x', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' }),
    (err) => err.deOperador && err.status === 400 && /URL/i.test(err.message)
  );
});

test('salvarIaConfig exige baseUrl para provedor OpenAI-compatível', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    tenants.salvarIaConfig({ operador: OPERADOR, tenantId: 5, provider: 'openrouter', modelo: 'm', apiKey: 'k' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarIaConfig sem apiKey e sem config prévia dá erro (não pode nascer sem chave)', async () => {
  db.getConnection = async () => conexao({ chaveExistente: null });
  await assert.rejects(
    tenants.salvarIaConfig({ operador: OPERADOR, tenantId: 5, provider: 'openrouter', modelo: 'm', baseUrl: 'https://openrouter.ai/api/v1' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarIaConfig sem apiKey MANTÉM a chave atual (editar só modelo/URL)', async () => {
  const conn = conexao({ chaveExistente: 'iv:tag:ct' });
  db.getConnection = async () => conn;
  await tenants.salvarIaConfig({ operador: OPERADOR, tenantId: 5, provider: 'openrouter', modelo: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' });
  const upsert = conn.cap.find((c) => /INSERT INTO ia_config/i.test(c.sql));
  assert.equal(upsert.binds.k, 'iv:tag:ct');
});

test('salvarIaConfig válido cifra a chave, faz upsert e audita (sem vazar a chave em claro)', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await tenants.salvarIaConfig({ operador: OPERADOR, tenantId: 5, provider: 'openai', modelo: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abc' });
  assert.equal(r.provider, 'openai');
  const upsert = conn.cap.find((c) => /INSERT INTO ia_config/i.test(c.sql));
  assert.ok(upsert, 'faz upsert');
  assert.ok(!JSON.stringify(conn.cap).includes('sk-abc'), 'a chave nunca vai em claro pro banco');
  assert.ok(conn.cap.some((c) => /INSERT INTO operador_auditoria|auditoria/i.test(c.sql)), 'audita a troca');
});

test('salvarIaConfig normaliza baseUrl (barra final e /chat/completions colado)', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  await tenants.salvarIaConfig({ operador: OPERADOR, tenantId: 5, provider: 'openrouter', modelo: 'm', baseUrl: 'https://openrouter.ai/api/v1/chat/completions/', apiKey: 'k' });
  const upsert = conn.cap.find((c) => /INSERT INTO ia_config/i.test(c.sql));
  assert.equal(upsert.binds.b, 'https://openrouter.ai/api/v1');
});

test('definirIa liga/desliga o plano do tenant e audita', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await tenants.definirIa({ operador: OPERADOR, tenantId: 5, habilitada: true });
  assert.equal(r.iaHabilitada, true);
  const upd = conn.cap.find((c) => /UPDATE tenant SET ia_habilitada/i.test(c.sql));
  assert.ok(upd, 'atualiza o flag');
  assert.equal(upd.binds.v, 'S');
});

test('definirIa/salvarIaConfig com tenant inexistente dá 404', async () => {
  db.getConnection = async () => conexao({ tenant: null });
  await assert.rejects(
    tenants.definirIa({ operador: OPERADOR, tenantId: 999, habilitada: true }),
    (err) => err.deOperador && err.status === 404
  );
});

// ---------------------------------------------------------------------------
// FIL-78 (achado de review, P2): desativarIaConfig — a migração gradual pra
// credencial global anunciada no ticket exige um caminho pra APOSENTAR a
// chave própria de um tenant, não só gravar uma nova.
// ---------------------------------------------------------------------------
test('desativarIaConfig sem chave própria ativa → 409 (nada pra desativar)', async () => {
  db.getConnection = async () => conexao({ ativoIaConfig: null });
  await assert.rejects(
    tenants.desativarIaConfig({ operador: OPERADOR, tenantId: 5 }),
    (err) => err.deOperador && err.status === 409
  );
});

test('desativarIaConfig com chave própria ativa: marca ativo=N, audita e invalida o cache do tenant', async () => {
  const iaConfigStore = require('../ia/iaConfigStore');
  let invalidado = null;
  const orig = iaConfigStore.invalidar;
  iaConfigStore.invalidar = (id) => { invalidado = id; };
  try {
    const conn = conexao({ ativoIaConfig: 'S' });
    db.getConnection = async () => conn;
    const r = await tenants.desativarIaConfig({ operador: OPERADOR, tenantId: 5, ip: '10.0.0.1' });
    assert.equal(r.chaveProprAtiva, false);
    const upd = conn.cap.find((c) => /UPDATE ia_config SET ativo = 'N'/i.test(c.sql));
    assert.ok(upd, 'marca ativo=N (não apaga a linha nem a chave)');
    assert.ok(conn.cap.some((c) => /INSERT INTO operador_auditoria|auditoria/i.test(c.sql)), 'audita a desativação');
    assert.equal(invalidado, 5, 'invalida o cache do tenant — a próxima chamada já usa o fallback global');
  } finally {
    iaConfigStore.invalidar = orig;
  }
});

test('desativarIaConfig com tenant inexistente dá 404', async () => {
  db.getConnection = async () => conexao({ tenant: null });
  await assert.rejects(
    tenants.desativarIaConfig({ operador: OPERADOR, tenantId: 999 }),
    (err) => err.deOperador && err.status === 404
  );
});

// ---------------------------------------------------------------------------
// FIL-78 (achado de review, P2): definirTetoIa — sem rota pra configurar o
// valor, o teto do plano (ia/limitePlano.js) nunca dispara na prática.
// ---------------------------------------------------------------------------
test('definirTetoIa grava o teto e audita', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await tenants.definirTetoIa({ operador: OPERADOR, tenantId: 5, tetoTokensMes: 100000, ip: '10.0.0.1' });
  assert.equal(r.tetoTokensMes, 100000);
  const upd = conn.cap.find((c) => /UPDATE tenant SET ia_teto_tokens_mes/i.test(c.sql));
  assert.ok(upd);
  assert.equal(upd.binds.v, 100000);
  assert.ok(conn.cap.some((c) => /INSERT INTO operador_auditoria|auditoria/i.test(c.sql)), 'audita a definição do teto');
});

test('definirTetoIa com null REMOVE o teto (sem limite)', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await tenants.definirTetoIa({ operador: OPERADOR, tenantId: 5, tetoTokensMes: null });
  assert.equal(r.tetoTokensMes, null);
  const upd = conn.cap.find((c) => /UPDATE tenant SET ia_teto_tokens_mes/i.test(c.sql));
  assert.equal(upd.binds.v, null);
});

test('definirTetoIa rejeita valor negativo ou não-inteiro', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    tenants.definirTetoIa({ operador: OPERADOR, tenantId: 5, tetoTokensMes: -1 }),
    (err) => err.deOperador && err.status === 400
  );
  await assert.rejects(
    tenants.definirTetoIa({ operador: OPERADOR, tenantId: 5, tetoTokensMes: 1.5 }),
    (err) => err.deOperador && err.status === 400
  );
});

test('definirTetoIa com tenant inexistente dá 404', async () => {
  db.getConnection = async () => conexao({ tenant: null });
  await assert.rejects(
    tenants.definirTetoIa({ operador: OPERADOR, tenantId: 999, tetoTokensMes: 100 }),
    (err) => err.deOperador && err.status === 404
  );
});
