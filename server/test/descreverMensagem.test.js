// Testes do helper de renderização amigável de mensagens (system, reaction, etc.).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { descreverMensagem } = require('../utils/descreverMensagem');

test('reaction com emoji', () => {
  assert.equal(descreverMensagem('reaction', { emoji: '🤝' }), 'reagiu com 🤝');
});
test('reaction sem emoji = removida', () => {
  assert.equal(descreverMensagem('reaction', {}), 'removeu a reação');
});
test('button devolve o texto', () => {
  assert.equal(descreverMensagem('button', { text: 'Sim' }), 'Sim');
});
test('interactive button_reply devolve o título', () => {
  assert.equal(descreverMensagem('interactive', { type: 'button_reply', button_reply: { title: 'Falar com atendente' } }), 'Falar com atendente');
});
test('interactive list_reply devolve o título', () => {
  assert.equal(descreverMensagem('interactive', { type: 'list_reply', list_reply: { title: '2a via' } }), '2a via');
});
test('system user_changed_number', () => {
  assert.match(descreverMensagem('system', { type: 'user_changed_number', wa_id: '5562' }), /trocou de número/);
});
test('system desconhecido cai no body', () => {
  assert.equal(descreverMensagem('system', { type: 'qualquer', body: 'algo' }), 'algo');
});
test('order com total', () => {
  const r = descreverMensagem('order', { product_items: [{ quantity: 2, item_price: 10, currency: 'BRL' }] });
  assert.match(r, /Pedido: 2 item/);
});
test('unsupported', () => {
  assert.match(descreverMensagem('unsupported', {}), /não suportada/);
});
test('contacts (array)', () => {
  const r = descreverMensagem('contacts', [{ name: { formatted_name: 'João' }, phones: [{ phone: '6299' }] }]);
  assert.match(r, /Contato compartilhado: João/);
});
test('location', () => {
  assert.match(descreverMensagem('location', { latitude: -16, longitude: -49, name: 'Loja' }), /Localização — Loja/);
});
test('tipo desconhecido = fallback, nunca JSON cru', () => {
  const r = descreverMensagem('foobar', { a: 1 });
  assert.equal(r, 'Mensagem do tipo "foobar"');
  assert.ok(!r.includes('{'));
});
