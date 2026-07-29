'use strict';
// FIL-84 — política de reanexo de imagem.
//
// O turno guarda o CAMINHO, não os bytes. A cada turno o histórico inteiro é
// recarregado e reenviado ao provedor — sem teto, uma conversa com dez fotos
// reenviaria as dez a CADA mensagem: custo quadrático em cima do item mais caro
// do prompt. Por isso só as 2 imagens mais recentes voltam de verdade; as
// antigas viram uma linha de texto dizendo que existiram.
const test = require('node:test');
const assert = require('node:assert');
const anexos = require('../ia/anexos');

const img = (caminho, texto = '') => ({ papel: 'user', texto, midiaCaminho: caminho, midiaMime: 'image/jpeg' });

test('seleciona as 2 imagens MAIS RECENTES', () => {
  const sel = anexos.selecionar([
    img('a.jpg'), { papel: 'assistant', texto: 'ok' },
    img('b.jpg'), { papel: 'assistant', texto: 'ok' },
    img('c.jpg'),
  ]);
  assert.deepEqual(sel.map((s) => s.caminho), ['c.jpg', 'b.jpg']);
});

test('não repete o mesmo caminho (o cliente reenviou a mesma foto)', () => {
  const sel = anexos.selecionar([img('a.jpg'), img('a.jpg'), img('b.jpg')]);
  assert.deepEqual(sel.map((s) => s.caminho), ['b.jpg', 'a.jpg']);
});

test('ignora mídia que não é imagem e turnos que não são do cliente', () => {
  const sel = anexos.selecionar([
    { papel: 'user', texto: '', midiaCaminho: 'a.ogg', midiaMime: 'audio/ogg' },
    { papel: 'assistant', texto: '', midiaCaminho: 'x.jpg', midiaMime: 'image/jpeg' },
  ]);
  assert.deepEqual(sel, []);
});

test('aplicar: as selecionadas ganham os bytes; as antigas viram placeholder', () => {
  const mensagens = [img('a.jpg', 'a primeira'), img('b.jpg'), img('c.jpg', 'olha o defeito')];
  const cache = new Map([
    ['b.jpg', { mime: 'image/jpeg', base64: 'BBB' }],
    ['c.jpg', { mime: 'image/jpeg', base64: 'CCC' }],
  ]);
  const out = anexos.aplicar(mensagens, cache);

  assert.equal(out[0].imagem, undefined, 'a mais antiga não pode voltar como bytes');
  assert.match(out[0].texto, /imagem enviada anteriormente/i);
  assert.match(out[0].texto, /a primeira/, 'o texto original do cliente não pode ser perdido');
  assert.equal(out[1].imagem.base64, 'BBB');
  assert.equal(out[2].imagem.base64, 'CCC');
  assert.equal(out[2].texto, 'olha o defeito');
});

test('aplicar: selecionada cujo arquivo sumiu do storage vira placeholder, não quebra o turno', () => {
  const out = anexos.aplicar([img('some.jpg', 'olha')], new Map());
  assert.equal(out[0].imagem, undefined);
  assert.match(out[0].texto, /imagem enviada anteriormente/i);
});

test('aplicar não toca em turno sem imagem', () => {
  const originais = [{ papel: 'user', texto: 'oi' }, { papel: 'assistant', texto: 'olá' }];
  assert.deepEqual(anexos.aplicar(originais, new Map()), originais);
});

test('carregarImagens: caminho que falha no storage simplesmente não entra no mapa', async () => {
  const { storage } = require('../storage');
  const original = storage.ler;
  storage.ler = async (k) => { if (k === 'ruim.jpg') throw new Error('sumiu'); return Buffer.from('bytes'); };
  try {
    const mapa = await anexos.carregarImagens([
      { caminho: 'bom.jpg', mime: 'image/jpeg' },
      { caminho: 'ruim.jpg', mime: 'image/png' },
    ]);
    assert.equal(mapa.get('bom.jpg').base64, Buffer.from('bytes').toString('base64'));
    assert.equal(mapa.has('ruim.jpg'), false);
  } finally { storage.ler = original; }
});

test('o teto de reanexo é 2 — mudar isto é decisão de custo, não detalhe', () => {
  assert.equal(anexos.LIMITE_REANEXOS, 2);
});
