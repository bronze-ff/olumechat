// realtime/hub.js — Barramento de eventos do SSE via Postgres LISTEN/NOTIFY.
// A conexão usada aqui é direta (session mode), separada do pool pooled da app.
'use strict';

const { Client } = require('pg');
const { EventEmitter } = require('node:events');

const PREFIXO_CANAL = 'falatta_realtime_tenant_';
const RETRY_MS = 5_000;

function tenantValido(tenantId) {
  const id = Number(tenantId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function canalDoTenant(tenantId) {
  const id = tenantValido(tenantId);
  if (!id) throw new Error(`hub: tenantId inválido: ${JSON.stringify(tenantId)}`);
  return `${PREFIXO_CANAL}${id}`;
}

function createHub({ clientFactory = (connectionString) => new Client({ connectionString }),
  directUrl = process.env.DATABASE_URL_DIRECT, retryMs = RETRY_MS } = {}) {
  const local = new EventEmitter();
  local.setMaxListeners(0);
  const tenants = new Map();
  let publisher = null;
  let listener = null;
  let retryTimer = null;
  let iniciado = false;
  let encerrando = false;
  let conectando = false;

  function emitir(evento) {
    const id = tenantValido(evento && evento.tenantId);
    if (!id) return;
    const inscritos = tenants.get(id);
    if (inscritos) for (const handler of inscritos) handler(evento);
  }

  async function conectar() {
    if (!directUrl || encerrando || conectando || listener) return;
    conectando = true;
    try {
      const novoListener = clientFactory(directUrl);
      novoListener.on('notification', (msg) => {
        try { emitir(JSON.parse(msg.payload)); } catch (err) {
          console.error('[realtime] NOTIFY inválido:', err.message);
        }
      });
      const caiu = () => {
        if (listener === novoListener) {
          listener = null;
          publisher = null;
          agendarReconexao();
        }
      };
      novoListener.on('error', (err) => {
        console.error('[realtime] barramento indisponível:', err.message);
        caiu();
      });
      novoListener.on('end', caiu);
      await novoListener.connect();
      listener = novoListener;
      for (const id of tenants.keys()) await listener.query(`LISTEN ${canalDoTenant(id)}`);
      const novoPublisher = clientFactory(directUrl);
      novoPublisher.on('error', (err) => {
        console.error('[realtime] publicador indisponível:', err.message);
        caiu();
      });
      await novoPublisher.connect();
      publisher = novoPublisher;
    } catch (err) {
      console.error('[realtime] conexão direta indisponível:', err.message);
      try { await listener?.end(); } catch { /* já caiu */ }
      try { await publisher?.end(); } catch { /* já caiu */ }
      listener = null;
      publisher = null;
      agendarReconexao();
    } finally {
      conectando = false;
    }
  }

  function agendarReconexao() {
    if (!iniciado || encerrando || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; conectar(); }, retryMs);
    if (retryTimer.unref) retryTimer.unref();
  }

  function start() {
    iniciado = true;
    if (!directUrl) {
      console.warn('[realtime] DATABASE_URL_DIRECT ausente; SSE externo desabilitado');
      return Promise.resolve(false);
    }
    return conectar().then(() => Boolean(listener && publisher));
  }

  async function stop() {
    encerrando = true;
    if (retryTimer) clearTimeout(retryTimer);
    await Promise.all([listener?.end(), publisher?.end()].map((p) => Promise.resolve(p).catch(() => {})));
    listener = null;
    publisher = null;
  }

  function publish(evento) {
    const id = tenantValido(evento && evento.tenantId);
    // Assinantes sem tenant são mantidos para compatibilidade com workers/testes;
    // o SSE sempre assina com tenant e nunca passa por este caminho.
    local.emit('evt', evento);
    if (!directUrl) {
      if (id) emitir(evento);
      else for (const inscritos of tenants.values()) for (const handler of inscritos) handler(evento);
    }
    if (!id || !publisher) return false;
    publisher.query('SELECT pg_notify($1, $2)', [canalDoTenant(id), JSON.stringify(evento)]).catch((err) => {
      console.error('[realtime] falha ao publicar:', err.message);
    });
    return true;
  }

  function subscribe(handler, tenantId) {
    if (tenantId === undefined) {
      local.on('evt', handler);
      return () => local.off('evt', handler);
    }
    const id = tenantValido(tenantId);
    if (!id) throw new Error(`hub: tenantId inválido: ${JSON.stringify(tenantId)}`);
    let inscritos = tenants.get(id);
    if (!inscritos) {
      inscritos = new Set();
      tenants.set(id, inscritos);
      if (listener) listener.query(`LISTEN ${canalDoTenant(id)}`).catch((err) => {
        console.error('[realtime] falha ao assinar tenant:', err.message);
      });
    }
    inscritos.add(handler);
    return () => {
      inscritos.delete(handler);
      if (!inscritos.size) tenants.delete(id);
    };
  }

  return { publish, subscribe, start, stop, _canalDoTenant: canalDoTenant };
}

const hub = createHub();
module.exports = {
  publish: hub.publish,
  subscribe: hub.subscribe,
  start: hub.start,
  stop: hub.stop,
  createHub,
  canalDoTenant,
};
