// FIL-77 — critério de aceite: "cada chamada de IA grava um evento com
// tokens reais do provedor (mock) e custo" + "falha ao gravar consumo NÃO
// quebra o envio nem a sugestão". Exercita ia/runtime.js (bot) de ponta a
// ponta, com o provedor mockado devolvendo `usage` real (nunca estimado).
'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
process.env.DEV_META_FALLBACK = process.env.DEV_META_FALLBACK || '1';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const store = require('../ia/iaConfigStore');
const client = require('../ia/client');
const auth = require('../ia/autorizacao');
const precos = require('../consumo/precos');
const runtime = require('../ia/runtime');

const TENANT_A = 501;

function connConversa({ falharNoConsumo = false } = {}) {
  const ins = [];
  return {
    ins,
    async execute(sql, binds) {
      if (sql.includes('ia_habilitada')) return { rows: [{ IA_HABILITADA: 'S' }] };
      if (sql.includes('FROM conversa')) return { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '111' }] };
      if (sql.includes('ia_teto_tokens_mes')) return { rows: [{ IA_TETO_TOKENS_MES: null }] };
      if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 0 }] };
      if (sql.includes('FROM ia_turno')) return { rows: [] };
      if (falharNoConsumo && /INSERT INTO consumo_evento/i.test(sql)) throw new Error('banco de consumo fora do ar (simulado)');
      ins.push({ sql, binds });
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test.beforeEach(() => {
  precos.invalidarCache();
});

test('cada chamada ao provedor grava um evento ia_tokens com os TOKENS REAIS devolvidos (nunca estimados)', async () => {
  const conn = connConversa();
  db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'claude-sonnet-5', apiKey: 'k' });
  auth.autorizado = async () => true;
  precos.carregarPreco = async () => ({ precoEntradaCentavos1k: 10, precoSaidaCentavos1k: 30 });
  client.chamar = async () => ({ texto: 'Tudo certo!', toolCalls: [], uso: { tokensEntrada: 400, tokensSaida: 120 } });
  global.fetch = async (u, o) => ({ ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) });

  await runtime.processarEntrada(TENANT_A, 88, 'oi');

  const evt = conn.ins.find((i) => /INSERT INTO consumo_evento/i.test(i.sql));
  assert.ok(evt, 'não gravou o evento de consumo de IA');
  assert.equal(evt.binds.tenantId, TENANT_A);
  assert.equal(evt.binds.tipo, 'ia_tokens');
  assert.equal(evt.binds.qtd, 520, 'quantidade = 400 (entrada) + 120 (saída), os valores REAIS do mock do provedor');
  // 400/1000*10 + 120/1000*30 = 4 + 3.6 = 7.6 centavos
  assert.equal(evt.binds.custo, 7.6);

  const teto = conn.ins.find((i) => /INSERT INTO ia_consumo_mensal/i.test(i.sql));
  assert.ok(teto, 'não alimentou o teto do FIL-78');
  assert.equal(teto.binds.tokens, 520);
});

test('FIL-76 (achado de review): a resposta final enviada ao cliente grava um evento mensagem_enviada (não existia produtor)', async () => {
  const conn = connConversa();
  db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'claude-sonnet-5', apiKey: 'k' });
  auth.autorizado = async () => true;
  precos.carregarPreco = async () => null;
  client.chamar = async () => ({ texto: 'Tudo certo!', toolCalls: [], uso: { tokensEntrada: 10, tokensSaida: 5 } });
  global.fetch = async (u, o) => ({ ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) });

  await runtime.processarEntrada(TENANT_A, 88, 'oi');

  const evt = conn.ins.find((i) => /INSERT INTO consumo_evento/i.test(i.sql) && i.binds.tipo === 'mensagem_enviada');
  assert.ok(evt, 'não gravou o evento de mensagem_enviada da resposta do bot de IA');
  assert.equal(evt.binds.tenantId, TENANT_A);
  assert.equal(evt.binds.qtd, 1);
});

test('sem `usage` na resposta do provedor: nenhum evento de ia_tokens é gravado (nunca estima por caractere)', async () => {
  const conn = connConversa();
  db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  client.chamar = async () => ({ texto: 'ok', toolCalls: [] }); // sem `uso`
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w' }] }) });

  await runtime.processarEntrada(TENANT_A, 88, 'oi');
  const eventosIaTokens = conn.ins.filter((i) => /INSERT INTO consumo_evento/i.test(i.sql) && i.binds.tipo === 'ia_tokens');
  assert.equal(eventosIaTokens.length, 0, 'sem uso devolvido pelo provedor, não pode estimar tokens');
});

test('REGRESSÃO (critério de aceite): falha ao gravar consumo NÃO impede o bot de responder ao cliente', async () => {
  const conn = connConversa({ falharNoConsumo: true });
  db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  precos.carregarPreco = async () => null;
  client.chamar = async () => ({ texto: 'Resposta normal do bot.', toolCalls: [], uso: { tokensEntrada: 50, tokensSaida: 20 } });
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };

  await runtime.processarEntrada(TENANT_A, 88, 'oi');
  assert.ok(enviados.some((e) => /Resposta normal do bot\./.test(e.text.body)), 'o cliente TEM que receber a resposta mesmo com a gravação de consumo falhando');
});
