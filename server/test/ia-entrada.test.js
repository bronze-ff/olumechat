'use strict';
// FIL-84 — o que chega para a IA.
//
// Obstáculo 7 do ticket: `processEvent.js` só empurrava `msg.type === 'text'`
// para a IA. Áudio, imagem, botão e localização NUNCA chegavam nela — o cliente
// mandava um áudio e recebia SILÊNCIO, que é o pior comportamento possível num
// canal de atendimento.
//
// Função PURA: roda no caminho quente do webhook e decide sem tocar em banco,
// storage nem rede.
const test = require('node:test');
const assert = require('node:assert');
const entrada = require('../ia/entrada');

const midia = (extra = {}) => ({ caminho: '1/88/abc.jpg', mime: 'image/jpeg', size: 1000, ...extra });

test('texto puro vira entrada de texto', () => {
  const e = entrada.classificar({ type: 'text', text: { body: 'oi' } }, 'oi', null);
  assert.equal(e.tipo, 'texto');
  assert.equal(e.texto, 'oi');
});

test('botão, lista, localização e pedido já chegam como TEXTO — custo zero', () => {
  // O webhook já roda descreverMensagem() e grava o texto amigável em
  // `conteudo`; para a IA é só mais uma fala do cliente.
  for (const tipo of ['button', 'interactive', 'location', 'order', 'request_welcome']) {
    const e = entrada.classificar({ type: tipo }, 'Segunda via do boleto', null);
    assert.equal(e.tipo, 'texto', `${tipo} deveria virar texto`);
    assert.equal(e.texto, 'Segunda via do boleto');
  }
});

test('áudio baixado vira entrada de áudio (o STT resolve depois, na fase 2)', () => {
  const e = entrada.classificar({ type: 'audio' }, null, midia({ mime: 'audio/ogg', caminho: '1/88/a.ogg', size: 20_000 }));
  assert.equal(e.tipo, 'audio');
  assert.equal(e.midiaCaminho, '1/88/a.ogg');
  assert.equal(e.mime, 'audio/ogg');
  assert.equal(e.tamanho, 20_000);
});

test('áudio grande demais NÃO vira transcrição: pede texto (custo e latência)', () => {
  const e = entrada.classificar({ type: 'audio' }, null, midia({ mime: 'audio/ogg', size: entrada.MAX_BYTES_AUDIO + 1 }));
  assert.equal(e.tipo, 'nao_suportado');
  assert.equal(e.tipoOriginal, 'audio_longo');
});

test('imagem em formato aceito vira entrada de imagem, com a legenda como texto', () => {
  const e = entrada.classificar({ type: 'image' }, 'esse é o produto', midia());
  assert.equal(e.tipo, 'imagem');
  assert.equal(e.texto, 'esse é o produto');
  assert.equal(e.midiaCaminho, '1/88/abc.jpg');
});

test('imagem em formato que os dois provedores não aceitam, ou acima de 5 MB, pede texto', () => {
  const gif = entrada.classificar({ type: 'image' }, null, midia({ mime: 'image/gif' }));
  assert.equal(gif.tipo, 'nao_suportado');
  const grande = entrada.classificar({ type: 'image' }, null, midia({ size: entrada.MAX_BYTES_IMAGEM + 1 }));
  assert.equal(grande.tipo, 'nao_suportado');
});

test('mídia que FALHOU no download não pode virar imagem/áudio fantasma', () => {
  // safeDownload devolve null quando o download falha — a mensagem existe, a
  // mídia não. Tratar como não suportado é honesto; tratar como imagem faria o
  // runtime tentar ler um caminho que não existe.
  assert.equal(entrada.classificar({ type: 'image' }, null, null).tipo, 'nao_suportado');
  assert.equal(entrada.classificar({ type: 'audio' }, null, null).tipo, 'nao_suportado');
});

test('vídeo, documento, sticker e contato pedem texto — NUNCA silêncio', () => {
  for (const tipo of ['video', 'document', 'sticker', 'contacts']) {
    const e = entrada.classificar({ type: tipo }, null, midia({ mime: 'video/mp4' }));
    assert.equal(e.tipo, 'nao_suportado', `${tipo} tem que gerar resposta educada`);
    assert.equal(e.tipoOriginal, tipo);
  }
});

test('reação, system e unsupported são IGNORADOS (não acordam a IA)', () => {
  for (const tipo of ['reaction', 'system', 'unsupported']) {
    assert.equal(entrada.classificar({ type: tipo }, 'x', null).tipo, 'ignorar');
  }
});

test('texto vazio não acorda a IA (nada a responder)', () => {
  assert.equal(entrada.classificar({ type: 'text', text: { body: '   ' } }, '   ', null).tipo, 'ignorar');
});

test('mime com charset ainda casa (image/jpeg; charset=binary)', () => {
  const e = entrada.classificar({ type: 'image' }, null, midia({ mime: 'image/jpeg; charset=binary' }));
  assert.equal(e.tipo, 'imagem');
  assert.equal(e.mime, 'image/jpeg', 'o mime normalizado é o que vai para o provedor');
});
