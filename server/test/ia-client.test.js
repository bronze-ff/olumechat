'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chamar } = require('../ia/client');

test('anthropic: monta a URL nativa e extrai tool_use', async () => {
  let capturado;
  global.fetch = async (url, opts) => {
    capturado = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ content: [
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'tu_1', name: 'consultar_vendas', input: { data_ini: '2026-06-01', data_fim: '2026-06-30' } },
    ] }) };
  };
  const r = await chamar({ config: { provider: 'anthropic', modelo: 'claude-sonnet-5', apiKey: 'k' },
    sistema: 'sys', mensagens: [{ papel: 'user', texto: 'vendas de junho' }] });
  assert.match(capturado.url, /api\.anthropic\.com/);
  assert.equal(r.toolCalls[0].nome, 'consultar_vendas');
  assert.equal(r.toolCalls[0].args.data_ini, '2026-06-01');
});

test('openai-compatível: usa baseUrl e extrai tool_calls', async () => {
  global.fetch = async (url, opts) => {
    assert.match(url, /openrouter\.ai/);
    return { ok: true, json: async () => ({ choices: [{ message: {
      content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'consultar_inadimplencia', arguments: '{}' } }] } }] }) };
  };
  const r = await chamar({ config: { provider: 'openrouter', modelo: 'x', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' },
    sistema: 'sys', mensagens: [{ papel: 'user', texto: 'inadimplência' }] });
  assert.equal(r.toolCalls[0].nome, 'consultar_inadimplencia');
});

test('erro HTTP do provedor vira Error', async () => {
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'x' }) });
  await assert.rejects(() => chamar({ config: { provider: 'anthropic', modelo: 'm', apiKey: 'k' }, sistema: 's', mensagens: [] }), /401/);
});
