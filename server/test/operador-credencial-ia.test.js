'use strict';
// operador/credencialIa.js — credencial GLOBAL do operador (FIL-78: fim da
// chave por tenant). Mesmo padrão de teste de operador-ia-config.test.js:
// comOperador roda tudo via db.getConnection (não passa por RLS de verdade,
// BYPASSRLS), então o fake só precisa devolver linhas plausíveis e registrar
// o que foi executado.
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const credencialIa = require('../operador/credencialIa');
const { chamar } = require('../ia/client');

const OPERADOR = { id: 1, email: 'op@olume.com' };

function conexao({ chaveExistente = null, credenciais = [] } = {}) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      cap.push({ sql, binds });
      if (/SELECT api_key_criptografada FROM provedor_credencial WHERE provider/i.test(sql)) {
        return { rows: chaveExistente ? [{ API_KEY_CRIPTOGRAFADA: chaveExistente }] : [] };
      }
      if (/SELECT provider, modelo_padrao, base_url, ativo, atualizado_em FROM provedor_credencial/i.test(sql)) {
        return { rows: credenciais };
      }
      if (/SELECT provider, modelo_padrao, base_url, api_key_criptografada FROM provedor_credencial WHERE ativo = 'S'/i.test(sql)) {
        const ativa = credenciais.find((c) => c.ATIVO === 'S');
        return { rows: ativa ? [ativa] : [] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('salvarCredencial rejeita provider inválido', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    credencialIa.salvarCredencial({ operador: OPERADOR, provider: 'zzz', modeloPadrao: 'x', apiKey: 'k' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarCredencial rejeita modelo que é URL', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    credencialIa.salvarCredencial({
      operador: OPERADOR, provider: 'openrouter', modeloPadrao: 'https://openrouter.ai/x',
      baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k',
    }),
    (err) => err.deOperador && err.status === 400 && /URL/i.test(err.message)
  );
});

test('salvarCredencial exige baseUrl para provedor OpenAI-compatível', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    credencialIa.salvarCredencial({ operador: OPERADOR, provider: 'openrouter', modeloPadrao: 'm', apiKey: 'k' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarCredencial sem apiKey e sem credencial prévia dá erro (não pode nascer sem chave)', async () => {
  db.getConnection = async () => conexao({ chaveExistente: null });
  await assert.rejects(
    credencialIa.salvarCredencial({ operador: OPERADOR, provider: 'openrouter', modeloPadrao: 'm', baseUrl: 'https://openrouter.ai/api/v1' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarCredencial sem apiKey MANTÉM a chave atual (editar só modelo/URL)', async () => {
  const conn = conexao({ chaveExistente: 'iv:tag:ct' });
  db.getConnection = async () => conn;
  await credencialIa.salvarCredencial({ operador: OPERADOR, provider: 'openrouter', modeloPadrao: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' });
  const upsert = conn.cap.find((c) => /INSERT INTO provedor_credencial/i.test(c.sql));
  assert.equal(upsert.binds.k, 'iv:tag:ct');
});

test('salvarCredencial válido cifra a chave, faz upsert e audita (sem vazar a chave em claro)', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await credencialIa.salvarCredencial({ operador: OPERADOR, provider: 'openai', modeloPadrao: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abc-super-secreta' });
  assert.equal(r.provider, 'openai');
  const upsert = conn.cap.find((c) => /INSERT INTO provedor_credencial/i.test(c.sql));
  assert.ok(upsert, 'faz upsert');
  assert.ok(!JSON.stringify(conn.cap).includes('sk-abc-super-secreta'), 'a chave nunca vai em claro pro banco');
  assert.ok(conn.cap.some((c) => /INSERT INTO operador_auditoria|auditoria/i.test(c.sql)), 'audita a troca');
  const auditoriaCall = conn.cap.find((c) => /INSERT INTO operador_auditoria/i.test(c.sql));
  if (auditoriaCall) {
    assert.ok(!JSON.stringify(auditoriaCall.binds).includes('sk-abc-super-secreta'), 'a chave não aparece nem no detalhe da auditoria');
  }
});

test('salvarCredencial troca a credencial ATIVA: desativa as demais antes do upsert', async () => {
  const conn = conexao({ chaveExistente: 'iv:tag:ct' });
  db.getConnection = async () => conn;
  await credencialIa.salvarCredencial({ operador: OPERADOR, provider: 'anthropic', modeloPadrao: 'claude-sonnet-5', apiKey: 'sk-nova' });
  const desativa = conn.cap.find((c) => /UPDATE provedor_credencial SET ativo = 'N'/i.test(c.sql));
  assert.ok(desativa, 'desativa as outras credenciais antes de ativar a nova');
  assert.equal(desativa.binds.p, 'anthropic');
  const idxDesativa = conn.cap.indexOf(desativa);
  const idxUpsert = conn.cap.findIndex((c) => /INSERT INTO provedor_credencial/i.test(c.sql));
  assert.ok(idxDesativa < idxUpsert, 'desativa ANTES de inserir/ativar a nova (índice único parcial exige isso)');
});

test('listarCredenciais nunca inclui a chave (nem a coluna cifrada)', async () => {
  db.getConnection = async () => conexao({
    credenciais: [
      { PROVIDER: 'anthropic', MODELO_PADRAO: 'claude-sonnet-5', BASE_URL: null, ATIVO: 'S', ATUALIZADO_EM: new Date() },
      { PROVIDER: 'openrouter', MODELO_PADRAO: 'openai/gpt-4o-mini', BASE_URL: 'https://openrouter.ai/api/v1', ATIVO: 'N', ATUALIZADO_EM: new Date() },
    ],
  });
  const lista = await credencialIa.listarCredenciais();
  assert.equal(lista.length, 2);
  for (const c of lista) {
    assert.ok(!('apiKey' in c) && !('API_KEY_CRIPTOGRAFADA' in c));
  }
  assert.equal(lista.find((c) => c.provider === 'anthropic').ativo, true);
  assert.equal(lista.find((c) => c.provider === 'openrouter').ativo, false);
});

test('carregarAtivaComChave decifra a credencial ativa (uso interno do runtime)', async () => {
  const { cifrar } = require('../ia/credencialOperador');
  const cifrada = cifrar('sk-ativa-123');
  db.getConnection = async () => conexao({
    credenciais: [{ PROVIDER: 'openai', MODELO_PADRAO: 'gpt-4o', BASE_URL: 'https://api.openai.com/v1', API_KEY_CRIPTOGRAFADA: cifrada, ATIVO: 'S' }],
  });
  const cfg = await credencialIa.carregarAtivaComChave();
  assert.equal(cfg.apiKey, 'sk-ativa-123');
  assert.equal(cfg.provider, 'openai');
});

test('carregarAtivaComChave sem nenhuma credencial ativa devolve null', async () => {
  db.getConnection = async () => conexao({ credenciais: [] });
  assert.equal(await credencialIa.carregarAtivaComChave(), null);
});

test('integração: credencial ativa do operador com base_url OpenRouter funciona com o client (mock)', async () => {
  const { cifrar } = require('../ia/credencialOperador');
  const cifrada = cifrar('sk-openrouter-abc');
  db.getConnection = async () => conexao({
    credenciais: [{
      PROVIDER: 'openrouter', MODELO_PADRAO: 'openai/gpt-4o-mini',
      BASE_URL: 'https://openrouter.ai/api/v1', API_KEY_CRIPTOGRAFADA: cifrada, ATIVO: 'S',
    }],
  });
  const config = await credencialIa.carregarAtivaComChave();
  assert.equal(config.apiKey, 'sk-openrouter-abc');

  let chamadaCapturada;
  const oldFetch = global.fetch;
  global.fetch = async (url, opts) => {
    chamadaCapturada = { url, headers: opts.headers };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }) };
  };
  try {
    const r = await chamar({ config: { provider: config.provider, modelo: config.modelo, baseUrl: config.baseUrl, apiKey: config.apiKey }, sistema: 's', mensagens: [] });
    assert.equal(r.texto, 'ok');
    assert.match(chamadaCapturada.url, /openrouter\.ai/);
    assert.equal(chamadaCapturada.headers.Authorization, 'Bearer sk-openrouter-abc');
  } finally {
    global.fetch = oldFetch;
  }
});
