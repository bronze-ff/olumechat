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

// ---------------------------------------------------------------------------
// FIL-84 — a IA vê imagem. Os dois provedores aceitam, com formatos DIFERENTES:
// Anthropic usa blocos {type:'image', source:{type:'base64'}}; OpenAI usa
// {type:'image_url'} com data URI. Errar o formato é 400 do provedor, que o
// runtime transforma em fallback genérico — o cliente nunca saberia por quê.
// ---------------------------------------------------------------------------
test('Anthropic: turno com imagem vira bloco image + bloco text', async () => {
  let corpo = null;
  global.fetch = async (u, o) => {
    corpo = JSON.parse(o.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }) };
  };
  await chamar({
    config: { provider: 'anthropic', modelo: 'm', apiKey: 'k' },
    sistema: 'S',
    mensagens: [{ papel: 'user', texto: 'olha o defeito', imagem: { mime: 'image/jpeg', base64: 'QUJD' } }],
  });
  const conteudo = corpo.messages[0].content;
  assert.ok(Array.isArray(conteudo));
  const imagem = conteudo.find((b) => b.type === 'image');
  assert.equal(imagem.source.type, 'base64');
  assert.equal(imagem.source.media_type, 'image/jpeg');
  assert.equal(imagem.source.data, 'QUJD');
  assert.ok(conteudo.some((b) => b.type === 'text' && b.text === 'olha o defeito'));
});

test('OpenAI: turno com imagem vira image_url com data URI', async () => {
  let corpo = null;
  global.fetch = async (u, o) => {
    corpo = JSON.parse(o.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) };
  };
  await chamar({
    config: { provider: 'openai', modelo: 'm', apiKey: 'k', baseUrl: 'https://api.openai.com/v1' },
    sistema: 'S',
    mensagens: [{ papel: 'user', texto: 'olha', imagem: { mime: 'image/png', base64: 'QUJD' } }],
  });
  const conteudo = corpo.messages.find((m) => m.role === 'user').content;
  assert.ok(Array.isArray(conteudo));
  assert.equal(conteudo.find((b) => b.type === 'image_url').image_url.url, 'data:image/png;base64,QUJD');
});

test('turno SEM imagem continua string simples (nada muda para quem nunca mandou foto)', async () => {
  let corpo = null;
  global.fetch = async (u, o) => {
    corpo = JSON.parse(o.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }) };
  };
  await chamar({
    config: { provider: 'anthropic', modelo: 'm', apiKey: 'k' },
    sistema: 'S', mensagens: [{ papel: 'user', texto: 'oi' }],
  });
  assert.equal(corpo.messages[0].content, 'oi');
});
