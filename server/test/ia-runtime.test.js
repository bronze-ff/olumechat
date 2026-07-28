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

const TENANT_A = 1;
const TENANT_B = 2;

function connConversa(fields = {}) {
  return { _ins: [], async execute(sql, binds) {
    // IA é add-on de plano (ia_habilitada em `tenant`) — habilitado por padrão
    // nos testes de runtime, que cobrem o comportamento do BOT em si.
    if (sql.includes('ia_habilitada')) return { rows: [{ IA_HABILITADA: 'S' }] };
    if (sql.includes('FROM conversa')) return { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '111' }] };
    if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 0 }] };
    if (sql.includes('FROM ia_turno')) return { rows: [] };
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

  await runtime.processarEntrada(TENANT_A, 88, 'vendas de junho?');
  assert.ok(enviados.some((e) => /70\.255\.176,46/.test(e.text.body)), 'deve enviar a resposta final');
  assert.ok(conn._ins.some((i) => i.sql.includes('INSERT INTO mensagem')), 'persiste msg visível');
  assert.ok(conn._ins.some((i) => i.sql.includes('INSERT INTO mensagem') && i.binds.tenantId === TENANT_A), 'msg gravada com o tenant_id certo');
});

test('não autorizado: recado e não chama o modelo', async () => {
  const conn = connConversa(); db.getConnection = async () => conn;
  auth.autorizado = async () => false;
  let chamouModelo = false; client.chamar = async () => { chamouModelo = true; return {}; };
  const enviados = []; global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(TENANT_A, 88, 'oi');
  assert.equal(chamouModelo, false);
  assert.ok(enviados.length >= 1, 'manda um recado educado');
});

test('sem provedor configurado: avisa e não quebra', async () => {
  const conn = connConversa(); db.getConnection = async () => conn;
  auth.autorizado = async () => true; store.carregar = async () => null;
  const enviados = []; global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(TENANT_A, 88, 'oi');
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
  await runtime.processarEntrada(TENANT_A, 88, 'vendas de ontem?');
  assert.ok(enviados.length >= 1, 'tem que enviar ALGO mesmo com o provedor falhando');
  assert.ok(enviados.some((e) => /indispon|não consegui|nao consegui/i.test(e.text.body)), 'envia o fallback');
});

test('plano sem IA (ia_habilitada=N): não responde mesmo com provedor configurado', async () => {
  const conn = {
    _ins: [], async execute(sql, binds) {
      if (sql.includes('ia_habilitada')) return { rows: [{ IA_HABILITADA: 'N' }] };
      if (sql.includes('FROM conversa')) return { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '111' }] };
      this._ins.push({ sql, binds }); return { rows: [] };
    }, commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  db.getConnection = async () => conn;
  auth.autorizado = async () => true;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  let chamouModelo = false; client.chamar = async () => { chamouModelo = true; return {}; };
  const enviados = []; global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(TENANT_A, 88, 'oi');
  assert.equal(chamouModelo, false, 'não chama o provedor de IA');
  assert.equal(enviados.length, 0, 'não manda nenhuma mensagem — plano sem IA é silencioso, não um recado');
});

test('tenantId inválido não toca o banco nem envia mensagem', async () => {
  const conn = connConversa(); db.getConnection = async () => conn;
  const enviados = []; global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(null, 88, 'oi'); // comTenant recusa antes de abrir conexão
  assert.equal(enviados.length, 0);
});

test('SEGURANÇA: toda leitura/gravação da conversa leva o tenant_id do chamador', async () => {
  const conn = connConversa(); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  client.chamar = async () => ({ texto: 'ok', toolCalls: [] });
  global.fetch = async (u, o) => ({ ok: true, json: async () => ({ messages: [{ id: 'w' }] }) });
  await runtime.processarEntrada(TENANT_B, 88, 'oi');
  const comBind = conn._ins.filter((i) => 'tenantId' in (i.binds || {}));
  assert.ok(comBind.length > 0);
  assert.ok(comBind.every((i) => i.binds.tenantId === TENANT_B), 'alguma query do runtime não levou o tenant_id do chamador');
});
