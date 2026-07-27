'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { criptografar } = require('../ia/crypto');
const store = require('../ia/iaConfigStore');
const SEG = 'segredo-de-teste-com-mais-de-32-chars-1234567890';
process.env.JWT_SECRET = SEG;

test('carrega a config ativa e decifra a chave', async () => {
  store.invalidar();
  const cifrada = criptografar('sk-123', SEG);
  const conn = { async execute() { return { rows: [{ PROVIDER: 'openai', MODELO: 'gpt-4o', BASE_URL: 'https://api.openai.com/v1', API_KEY_CRIPTOGRAFADA: cifrada }] }; } };
  const cfg = await store.carregar(conn);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-123');
});

test('sem linha ativa devolve null', async () => {
  store.invalidar();
  const conn = { async execute() { return { rows: [] }; } };
  assert.equal(await store.carregar(conn), null);
});
