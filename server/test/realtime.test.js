// Testes do hub de eventos (SSE) e dos tickets de uso único.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { publish, subscribe } = require('../realtime/hub');
const { createHub } = require('../realtime/hub');
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

test('hub: duas instâncias propagam evento pelo canal do tenant', async () => {
  const clients = new Set();
  class FakeClient extends EventEmitter {
    async connect() { clients.add(this); }
    async query(sql, values) {
      if (sql.startsWith('LISTEN ')) { this.canais = this.canais || new Set(); this.canais.add(sql.slice(7)); return; }
      if (sql.includes('pg_notify')) {
        for (const c of clients) if (c.canais?.has(values[0])) c.emit('notification', { channel: values[0], payload: values[1] });
      }
    }
    async end() { clients.delete(this); }
  }
  const factory = () => new FakeClient();
  const a = createHub({ directUrl: 'direct', clientFactory: factory });
  const b = createHub({ directUrl: 'direct', clientFactory: factory });
  const recebidos = [];
  b.subscribe((evento) => recebidos.push(evento), 7);
  a.start(); b.start();
  await new Promise((resolve) => setImmediate(resolve));
  a.publish({ tipo: 'mensagem', tenantId: 7, conversaId: 42 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recebidos.map((e) => e.conversaId), [42]);
  a.publish({ tipo: 'mensagem', tenantId: 8, conversaId: 99 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recebidos.length, 1);
  // B só assinou o canal do tenant 7: o evento do tenant 8 nem chega a B.
  await Promise.all([a.stop(), b.stop()]);
});

test('hub: queda da conexão não propaga erro ao processo e tenta reconectar', async () => {
  const clients = [];
  class FakeClient extends EventEmitter {
    async connect() { clients.push(this); }
    async query() {}
    async end() {}
  }
  const hub = createHub({ directUrl: 'direct', clientFactory: () => new FakeClient(), retryMs: 1 });
  hub.start();
  await new Promise((resolve) => setImmediate(resolve));
  clients[0].emit('error', new Error('queda simulada'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(clients.length >= 3); // listener + publisher e pelo menos uma tentativa nova
  await hub.stop();
});

test('hub: queda do publicador via end reconecta e publica novamente', async () => {
  const clients = [];
  const notificacoes = [];
  class FakeClient extends EventEmitter {
    async connect() { clients.push(this); }
    async query(sql, values) {
      if (sql.includes('pg_notify')) notificacoes.push(values);
    }
    async end() {}
  }
  const hub = createHub({ directUrl: 'direct', clientFactory: () => new FakeClient(), retryMs: 1 });
  await hub.start();
  clients[1].emit('end');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(clients.length >= 4); // listener + publisher inicial e um novo par
  assert.equal(hub.publish({ tipo: 'mensagem', tenantId: 7 }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notificacoes.length, 1);
  await hub.stop();
});

test('hub: ao sair o ultimo assinante, o canal e desassinado', async () => {
  const queries = [];
  class FakeClient extends EventEmitter {
    async connect() {}
    async query(sql) { queries.push(sql); }
    async end() {}
  }
  const hub = createHub({ directUrl: 'direct', clientFactory: () => new FakeClient() });
  await hub.start();
  const cancelar = hub.subscribe(() => {}, 7);
  await new Promise((resolve) => setImmediate(resolve));
  cancelar();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queries, ['LISTEN olume_realtime_tenant_7', 'UNLISTEN olume_realtime_tenant_7']);

  queries.length = 0;
  const cancelarNovamente = hub.subscribe(() => {}, 7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queries, ['LISTEN olume_realtime_tenant_7']);
  cancelarNovamente();
  await hub.stop();
});
