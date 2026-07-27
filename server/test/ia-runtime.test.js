'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const store = require('../ia/iaConfigStore');
const client = require('../ia/client');
const toolExec = require('../ia/toolExecutor');
const auth = require('../ia/autorizacao');
const runtime = require('../ia/runtime');

function connConversa(fields = {}) {
  return { _ins: [], async execute(sql, binds) {
    if (sql.includes('FROM MC_ZAP_CONVERSA')) return { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '111' }] };
    if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 0 }] };
    if (sql.includes('FROM MC_ZAP_IA_TURNO')) return { rows: [] };
    this._ins.push({ sql, binds }); return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} };
}

test('pergunta autorizada: chama tool, responde e persiste', async () => {
  const conn = connConversa(); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  toolExec.executar = async () => ({ colunas: ['VL_VENDA'], linhas: [{ VL_VENDA: 70255176.46 }] });
  let passo = 0;
  client.chamar = async () => (passo++ === 0
    ? { texto: '', toolCalls: [{ id: 't1', nome: 'consultar_vendas', args: { data_ini: '2026-06-01', data_fim: '2026-06-30' } }] }
    : { texto: 'As vendas de junho foram R$ 70.255.176,46.', toolCalls: [] });
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) }; };

  await runtime.processarEntrada(88, 'vendas de junho?');
  assert.ok(enviados.some((e) => /70\.255\.176,46/.test(e.text.body)), 'deve enviar a resposta final');
  assert.ok(conn._ins.some((i) => i.sql.includes('INSERT INTO MC_ZAP_MENSAGEM')), 'persiste msg visível');
});

test('não autorizado: recado e não chama o modelo', async () => {
  const conn = connConversa(); db.getConnection = async () => conn;
  auth.autorizado = async () => false;
  let chamouModelo = false; client.chamar = async () => { chamouModelo = true; return {}; };
  const enviados = []; global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(88, 'oi');
  assert.equal(chamouModelo, false);
  assert.ok(enviados.length >= 1, 'manda um recado educado');
});

test('sem provedor configurado: avisa e não quebra', async () => {
  const conn = connConversa(); db.getConnection = async () => conn;
  auth.autorizado = async () => true; store.carregar = async () => null;
  const enviados = []; global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(88, 'oi');
  assert.ok(enviados.some((e) => /indispon/i.test(e.text.body) || /configurad/i.test(e.text.body)));
});

test('provedor lança erro (400/timeout): usuário recebe FALLBACK — nunca silêncio', async () => {
  // Regressão do bug crítico: client.chamar lançava e o runtime engolia o erro
  // sem mandar nada. Agora tem que enviar o fallback amigável.
  const conn = connConversa(); db.getConnection = async () => conn;
  auth.autorizado = async () => true;
  store.carregar = async () => ({ provider: 'openrouter', modelo: 'x/y', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' });
  client.chamar = async () => { throw new Error('Provedor openrouter 400: modelo inválido'); };
  const enviados = []; global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(88, 'vendas de ontem?');
  assert.ok(enviados.length >= 1, 'tem que enviar ALGO mesmo com o provedor falhando');
  assert.ok(enviados.some((e) => /indispon|não consegui|nao consegui/i.test(e.text.body)), 'envia o fallback');
});
