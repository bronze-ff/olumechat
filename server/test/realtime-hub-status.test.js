// Testes do estado do hub SSE/LISTEN-NOTIFY (server/realtime/hub.js) — FIL-93
// (P0.7): /health/ready precisa reportar se o barramento está inicializado ou
// caído, sem inventar dependência de R2 no ready. createHub() já aceita
// clientFactory/directUrl por injeção (mesmo padrão usado nos outros testes
// que mockam client Postgres) — reaproveitado aqui para não precisar de um
// Postgres real.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHub } = require('../realtime/hub');

function clienteFake({ falhaAoConectar = false } = {}) {
  const ee = new EventEmitter();
  ee.connect = async () => { if (falhaAoConectar) throw new Error('conexão recusada'); };
  ee.end = async () => {};
  ee.query = async () => {};
  return ee;
}

test('hub.status(): sem DATABASE_URL_DIRECT, reporta desabilitado (não é falha — SSE externo é opcional)', () => {
  const hub = createHub({ directUrl: '', clientFactory: () => clienteFake() });
  const status = hub.status();
  assert.equal(status.habilitado, false);
  assert.equal(status.conectado, false);
});

test('hub.status(): antes de start(), reporta não conectado', () => {
  const hub = createHub({ directUrl: 'postgres://fake', clientFactory: () => clienteFake() });
  const status = hub.status();
  assert.equal(status.habilitado, true);
  assert.equal(status.conectado, false);
});

test('hub.status(): depois de start() com sucesso, reporta conectado', async () => {
  const hub = createHub({ directUrl: 'postgres://fake', clientFactory: () => clienteFake() });
  await hub.start();
  assert.deepEqual(hub.status(), { habilitado: true, conectado: true });
  await hub.stop();
});

test('hub.status(): se a conexão falha, reporta habilitado porém não conectado (caído)', async () => {
  const hub = createHub({ directUrl: 'postgres://fake', clientFactory: () => clienteFake({ falhaAoConectar: true }), retryMs: 999_999 });
  await hub.start();
  assert.deepEqual(hub.status(), { habilitado: true, conectado: false });
  await hub.stop();
});

test('hub.status(): depois de stop(), volta a reportar não conectado', async () => {
  const hub = createHub({ directUrl: 'postgres://fake', clientFactory: () => clienteFake() });
  await hub.start();
  await hub.stop();
  assert.equal(hub.status().conectado, false);
});
