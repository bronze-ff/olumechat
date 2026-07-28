'use strict';
process.env.JWT_SECRET = 'seg-teste-32-chars-abcdefghijk';
// FIL-84 — a IA escuta áudio.
//
// STT é SEMPRE OpenAI, independente do provedor de chat do tenant: a Anthropic
// não tem API de áudio. Credencial: a do tenant se o provedor dele já for
// OpenAI; senão a credencial OpenAI GLOBAL do operador (provedor_credencial) —
// lida INDEPENDENTE de `ativo`, porque a credencial ativa costuma ser a
// Anthropic e ainda assim o operador pode ter uma chave OpenAI cadastrada.
//
// Modelo: whisper-1. É o que aceita response_format=verbose_json e devolve
// `duration` — de onde sai a quantidade do evento de consumo `ia_audio_seg`.
// gpt-4o-mini-transcribe não devolve duração, e sem duração não há medição.
const test = require('node:test');
const assert = require('node:assert');
const stt = require('../ia/stt');
const operadorDb = require('../operador/db');
const credencialOperador = require('../ia/credencialOperador');

test('o modelo é whisper-1 (o único que devolve a duração que o consumo mede)', () => {
  assert.equal(stt.MODELO, 'whisper-1');
});

test('tenant com provedor OpenAI usa a própria chave, sem tocar no operador', async () => {
  let abriuOperador = false;
  const original = operadorDb.comOperador;
  operadorDb.comOperador = async () => { abriuOperador = true; return null; };
  try {
    const cred = await stt.credencialOpenAI({ provider: 'openai', apiKey: 'sk-do-tenant', baseUrl: 'https://api.openai.com/v1' });
    assert.equal(cred.apiKey, 'sk-do-tenant');
    assert.equal(abriuOperador, false, 'não pode abrir transação de operador à toa');
  } finally { operadorDb.comOperador = original; }
});

test('tenant com provedor Anthropic cai na credencial OpenAI global do operador', async () => {
  const original = operadorDb.comOperador;
  const decifrarOriginal = credencialOperador.decifrar;
  operadorDb.comOperador = async (fn) => fn({
    async execute(sql) {
      assert.match(sql, /provedor_credencial/);
      assert.match(sql, /provider = 'openai'/i);
      assert.ok(!/ativo\s*=\s*'S'/i.test(sql),
        'a credencial ATIVA costuma ser a Anthropic — a chave OpenAI é lida mesmo assim');
      return { rows: [{ BASE_URL: null, API_KEY_CRIPTOGRAFADA: 'blob' }] };
    },
  });
  credencialOperador.decifrar = () => 'sk-do-operador';
  try {
    const cred = await stt.credencialOpenAI({ provider: 'anthropic', apiKey: 'sk-ant' });
    assert.equal(cred.apiKey, 'sk-do-operador');
    assert.equal(cred.baseUrl, 'https://api.openai.com/v1');
  } finally {
    operadorDb.comOperador = original;
    credencialOperador.decifrar = decifrarOriginal;
  }
});

test('sem nenhuma credencial OpenAI: devolve null (a IA vai pedir texto, não ficar muda)', async () => {
  const original = operadorDb.comOperador;
  operadorDb.comOperador = async (fn) => fn({ async execute() { return { rows: [] }; } });
  try {
    assert.equal(await stt.credencialOpenAI({ provider: 'anthropic', apiKey: 'k' }), null);
  } finally { operadorDb.comOperador = original; }
});

test('credencial não decifrável não derruba o turno: devolve null', async () => {
  const original = operadorDb.comOperador;
  const decifrarOriginal = credencialOperador.decifrar;
  operadorDb.comOperador = async (fn) => fn({
    async execute() { return { rows: [{ BASE_URL: null, API_KEY_CRIPTOGRAFADA: 'corrompido' }] }; },
  });
  credencialOperador.decifrar = () => { throw new Error('blob corrompido'); };
  try {
    assert.equal(await stt.credencialOpenAI({ provider: 'anthropic', apiKey: 'k' }), null);
  } finally {
    operadorDb.comOperador = original;
    credencialOperador.decifrar = decifrarOriginal;
  }
});

test('transcrever manda multipart para /audio/transcriptions e devolve texto + duração', async () => {
  let capturado = null;
  global.fetch = async (url, opts) => {
    capturado = { url, opts };
    return { ok: true, json: async () => ({ text: 'quero a segunda via do boleto', duration: 7.4 }) };
  };
  const r = await stt.transcrever({
    apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1',
    buffer: Buffer.from('audio-falso'), mime: 'audio/ogg', nomeArquivo: 'a.ogg',
  });
  assert.equal(r.texto, 'quero a segunda via do boleto');
  assert.equal(r.segundos, 7.4);
  assert.match(capturado.url, /\/audio\/transcriptions$/);
  assert.equal(capturado.opts.headers.Authorization, 'Bearer sk-x');
  assert.ok(capturado.opts.body instanceof FormData);
  assert.equal(capturado.opts.body.get('model'), 'whisper-1');
  assert.equal(capturado.opts.body.get('response_format'), 'verbose_json');
});

test('erro HTTP do provedor vira exceção com o status (o runtime cai no pedido de texto)', async () => {
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'chave inválida' } }) });
  await assert.rejects(
    () => stt.transcrever({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', buffer: Buffer.from('x'), mime: 'audio/ogg', nomeArquivo: 'a.ogg' }),
    /401/);
});

test('transcreverEntrada NUNCA lança — falha vira { ok:false } e o atendimento segue', async () => {
  const original = operadorDb.comOperador;
  operadorDb.comOperador = async () => { throw new Error('banco caiu'); };
  try {
    const r = await stt.transcreverEntrada({ provider: 'anthropic', apiKey: 'k' }, { midiaCaminho: '1/88/a.ogg', mime: 'audio/ogg' });
    assert.equal(r.ok, false);
  } finally { operadorDb.comOperador = original; }
});

test('transcreverEntrada sem credencial devolve motivo sem_credencial (não tenta a rede)', async () => {
  const original = operadorDb.comOperador;
  operadorDb.comOperador = async (fn) => fn({ async execute() { return { rows: [] }; } });
  let bateuNaRede = false;
  global.fetch = async () => { bateuNaRede = true; return { ok: true, json: async () => ({}) }; };
  try {
    const r = await stt.transcreverEntrada({ provider: 'anthropic', apiKey: 'k' }, { midiaCaminho: '1/88/a.ogg', mime: 'audio/ogg' });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'sem_credencial');
    assert.equal(bateuNaRede, false);
  } finally { operadorDb.comOperador = original; }
});

test('transcrição vazia não vira turno do usuário (não há o que perguntar ao modelo)', async () => {
  const { storage } = require('../storage');
  const lerOriginal = storage.ler;
  const transcreverOriginal = stt.transcrever;
  const original = operadorDb.comOperador;
  operadorDb.comOperador = async (fn) => fn({
    async execute() { return { rows: [{ BASE_URL: null, API_KEY_CRIPTOGRAFADA: 'x' }] }; },
  });
  const decifrarOriginal = credencialOperador.decifrar;
  credencialOperador.decifrar = () => 'sk';
  storage.ler = async () => Buffer.from('bytes');
  stt.transcrever = async () => ({ texto: '   ', segundos: 3 });
  try {
    const r = await stt.transcreverEntrada({ provider: 'anthropic' }, { midiaCaminho: '1/88/a.ogg', mime: 'audio/ogg' });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'vazio');
  } finally {
    operadorDb.comOperador = original;
    credencialOperador.decifrar = decifrarOriginal;
    storage.ler = lerOriginal;
    stt.transcrever = transcreverOriginal;
  }
});
