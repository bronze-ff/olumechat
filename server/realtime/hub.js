// realtime/hub.js — Barramento de eventos in-process (sem Redis).
// O worker do webhook e os handlers de envio publicam eventos; cada conexão
// SSE (api/stream.js) assina e repassa ao navegador. Como o serviço é único
// processo, um EventEmitter resolve o tempo-real sem dependências externas.
'use strict';

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // muitas conexões SSE simultâneas

/** Publica um evento para todos os clientes conectados. */
function publish(evento) {
  bus.emit('evt', evento);
}

/** Assina os eventos; devolve uma função para cancelar a assinatura. */
function subscribe(handler) {
  bus.on('evt', handler);
  return () => bus.off('evt', handler);
}

module.exports = { publish, subscribe };
