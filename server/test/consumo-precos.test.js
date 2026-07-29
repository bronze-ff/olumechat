// consumo/precos.js — tabela de preço por provider/modelo, mantida pelo
// operador (FIL-77): explícita e editável, nunca hardcoded no runtime.
// Mesmo padrão de teste de operador-credencial-ia.test.js: comOperador roda
// via db.getConnection (duble), sem RLS de verdade (BYPASSRLS).
'use strict';
process.env.META_APP_SECRET = 'x'; process.env.WEBHOOK_VERIFY_TOKEN = 'x'; process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = 'x'; process.env.WA_BUSINESS_ACCOUNT_ID = 'x'; process.env.JWT_SECRET = 'seg-teste-32-chars-abcdefghijk';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const precos = require('../consumo/precos');

const OPERADOR = { id: 1, email: 'op@olume.com' };

function conexao({ linhas = [] } = {}) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      cap.push({ sql, binds });
      if (/SELECT provider, modelo, preco_entrada_centavos_1k, preco_saida_centavos_1k, atualizado_em[\s\S]*FROM preco_provedor ORDER/i.test(sql)) {
        return { rows: linhas };
      }
      if (/SELECT preco_entrada_centavos_1k, preco_saida_centavos_1k FROM preco_provedor[\s\S]*WHERE/i.test(sql)) {
        const achado = linhas.find((l) => l.PROVIDER === binds.p && l.MODELO === binds.m);
        return { rows: achado ? [achado] : [] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('salvarPreco rejeita provider fora da allowlist', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    precos.salvarPreco({ operador: OPERADOR, provider: 'zzz', modelo: 'x', precoEntradaCentavos1k: 1, precoSaidaCentavos1k: 1 }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarPreco rejeita modelo vazio', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    precos.salvarPreco({ operador: OPERADOR, provider: 'anthropic', modelo: '  ', precoEntradaCentavos1k: 1, precoSaidaCentavos1k: 1 }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarPreco rejeita preço negativo', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    precos.salvarPreco({ operador: OPERADOR, provider: 'anthropic', modelo: 'x', precoEntradaCentavos1k: -1, precoSaidaCentavos1k: 1 }),
    (err) => err.deOperador && err.status === 400
  );
});

test('salvarPreco válido faz upsert, audita e invalida o cache', async () => {
  precos.invalidarCache();
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await precos.salvarPreco({
    operador: OPERADOR, provider: 'openai', modelo: 'gpt-4o',
    precoEntradaCentavos1k: 2.5, precoSaidaCentavos1k: 10,
  });
  assert.equal(r.provider, 'openai');
  assert.equal(r.modelo, 'gpt-4o');
  const upsert = conn.cap.find((c) => /INSERT INTO preco_provedor/i.test(c.sql));
  assert.ok(upsert, 'faz upsert');
  assert.match(upsert.sql, /ON CONFLICT \(provider, modelo\) DO UPDATE/i);
  assert.ok(conn.cap.some((c) => /INSERT INTO operador_auditoria|auditoria/i.test(c.sql)), 'audita a alteração de preço');
});

test('listarPrecos mapeia as linhas em camelCase', async () => {
  db.getConnection = async () => conexao({
    linhas: [{ PROVIDER: 'anthropic', MODELO: 'claude-x', PRECO_ENTRADA_CENTAVOS_1K: 5, PRECO_SAIDA_CENTAVOS_1K: 15, ATUALIZADO_EM: new Date() }],
  });
  const lista = await precos.listarPrecos();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].precoEntradaCentavos1k, 5);
  assert.equal(lista[0].precoSaidaCentavos1k, 15);
});

test('carregarPreco: usa o cache dentro do TTL (não reconsulta o banco na 2ª chamada)', async () => {
  precos.invalidarCache();
  const conn = conexao({
    linhas: [{ PROVIDER: 'anthropic', MODELO: 'claude-x', PRECO_ENTRADA_CENTAVOS_1K: 5, PRECO_SAIDA_CENTAVOS_1K: 15 }],
  });
  db.getConnection = async () => conn;
  const p1 = await precos.carregarPreco('anthropic', 'claude-x');
  assert.equal(p1.precoEntradaCentavos1k, 5);
  const chamadasAntes = conn.cap.length;
  const p2 = await precos.carregarPreco('anthropic', 'claude-x');
  assert.equal(p2.precoEntradaCentavos1k, 5);
  assert.equal(conn.cap.length, chamadasAntes, 'não deveria ter tocado o banco de novo (cache)');
});

test('carregarPreco: sem preço cadastrado devolve null (custo desconhecido, não inventado)', async () => {
  precos.invalidarCache();
  db.getConnection = async () => conexao({ linhas: [] });
  const p = await precos.carregarPreco('anthropic', 'inexistente');
  assert.equal(p, null);
});

test('carregarPreco: erro no banco é capturado e devolve null (não derruba quem chama)', async () => {
  precos.invalidarCache();
  db.getConnection = async () => ({
    async execute() { throw new Error('banco fora do ar'); },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  });
  await assert.doesNotReject(precos.carregarPreco('anthropic', 'x'));
  assert.equal(await precos.carregarPreco('anthropic', 'x'), null);
});
