// Testes do hub de eventos (SSE) e dos tickets de uso único.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { publish, subscribe } = require('../realtime/hub');
const { criarTicket, consumirTicket } = require('../auth/sseTicket');

test('hub: subscribe recebe o evento publicado e cancela depois', () => {
  const recebidos = [];
  const cancelar = subscribe((e) => recebidos.push(e));
  publish({ tipo: 'mensagem', conversaId: 1 });
  publish({ tipo: 'status', wamid: 'x' });
  cancelar();
  publish({ tipo: 'mensagem', conversaId: 2 }); // já cancelado, não recebe
  assert.equal(recebidos.length, 2);
  assert.equal(recebidos[0].conversaId, 1);
});

test('sseTicket: ticket válido é consumido uma única vez', () => {
  const t = criarTicket({ matricula: 7, nome: 'Teste' });
  const u = consumirTicket(t);
  assert.equal(u.matricula, 7);
  assert.equal(consumirTicket(t), null); // segundo uso falha
});

test('sseTicket: ticket inexistente retorna null', () => {
  assert.equal(consumirTicket('naoexiste'), null);
});
