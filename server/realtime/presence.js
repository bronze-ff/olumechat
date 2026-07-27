// realtime/presence.js — Presença dos atendentes (online/pausa/offline).
//
// Online = tem pelo menos 1 conexão SSE ativa (refcount — várias abas contam 1).
// Queda de conexão tem GRAÇA de 60s antes de marcar offline (o EventSource
// reconecta em ~5s; sem a graça, todo refresh dispararia redistribuição).
// Pausa é manual e persiste em MC_ZAP_ATENDENTE.STATUS_PRESENCA (sobrevive a
// restart); o online em si é só memória — reconstruído quando os SSE reconectam.
'use strict';

const db = require('../db/pool');
const { publish } = require('./hub');

const GRACA_MS = 60_000;

// atendenteId -> { conexoes, pausado, deptoIds, matricula, nome, lastAssignedAt, gracaTimer }
const mapa = new Map();

let aoFicarOnline = null; // callback (distribuidor) — setado pelo app no boot

function setAoFicarOnline(fn) { aoFicarOnline = fn; }

function entrada(atendenteId) {
  if (!mapa.has(atendenteId)) {
    mapa.set(atendenteId, {
      conexoes: 0, pausado: false, deptoIds: [], numeroIds: [], matricula: null, nome: null,
      lastAssignedAt: 0, gracaTimer: null,
    });
  }
  return mapa.get(atendenteId);
}

function estaOnline(e) { return e.conexoes > 0 || e.gracaTimer !== null; }
function estadoDe(e) {
  if (!estaOnline(e)) return 'offline';
  return e.pausado ? 'pausa' : 'online';
}

/** Nova conexão SSE do atendente. Devolve true se ele FICOU online agora. */
function conectar({ atendenteId, deptoIds, numeroIds, matricula, nome, pausado }) {
  const e = entrada(atendenteId);
  const estavaOnline = estaOnline(e);
  e.conexoes += 1;
  e.deptoIds = deptoIds || e.deptoIds;
  if (numeroIds !== undefined) e.numeroIds = numeroIds || [];
  e.matricula = matricula ?? e.matricula;
  e.nome = nome ?? e.nome;
  if (pausado !== undefined) e.pausado = !!pausado;
  if (e.gracaTimer) { clearTimeout(e.gracaTimer); e.gracaTimer = null; }

  if (!estavaOnline) {
    publish({ tipo: 'presenca', atendenteId, estado: estadoDe(e) });
    if (!e.pausado && aoFicarOnline) aoFicarOnline(atendenteId, e.deptoIds);
    return true;
  }
  return false;
}

/** Conexão SSE fechou. Se era a última, abre a janela de graça. */
function desconectar(atendenteId) {
  const e = mapa.get(atendenteId);
  if (!e) return;
  e.conexoes = Math.max(0, e.conexoes - 1);
  if (e.conexoes === 0 && !e.gracaTimer) {
    e.gracaTimer = setTimeout(() => {
      e.gracaTimer = null;
      if (e.conexoes === 0) {
        publish({ tipo: 'presenca', atendenteId, estado: 'offline' });
      }
    }, GRACA_MS);
    if (e.gracaTimer.unref) e.gracaTimer.unref();
  }
}

/** Pausa/retoma (persiste no banco para sobreviver a restart). */
async function definirPausa(atendenteId, pausado) {
  const e = entrada(atendenteId);
  e.pausado = !!pausado;

  let conn;
  try {
    conn = await db.getConnection();
    await conn.execute(
      `UPDATE MC_ZAP_ATENDENTE SET STATUS_PRESENCA = :s WHERE ID = :id`,
      { s: pausado ? 'pausa' : 'online', id: atendenteId }
    );
    await conn.commit();
  } finally {
    if (conn) await conn.close().catch(() => {});
  }

  publish({ tipo: 'presenca', atendenteId, estado: estadoDe(e) });
  if (!pausado && estaOnline(e) && aoFicarOnline) aoFicarOnline(atendenteId, e.deptoIds);
}

/** IDs dos atendentes online (não pausados) que atendem o departamento. */
function onlineDoDepto(departamentoId) {
  const out = [];
  for (const [id, e] of mapa) {
    if (estaOnline(e) && !e.pausado && e.deptoIds.includes(departamentoId)) out.push(id);
  }
  return out;
}

/** Números (canais) que o atendente atende — lista vazia = TODOS. */
function numerosDe(atendenteId) {
  const e = mapa.get(atendenteId);
  return e && Array.isArray(e.numeroIds) ? e.numeroIds : [];
}

/** O atendente atende esse número? Sem número na conversa, ou sem restrição
    no atendente (lista vazia), = sim. */
function atendeNumero(atendenteId, numeroId) {
  if (!numeroId) return true; // conversa sem número → sem restrição
  const nums = numerosDe(atendenteId);
  return nums.length === 0 || nums.includes(numeroId);
}

function marcarAtribuicao(atendenteId) {
  entrada(atendenteId).lastAssignedAt = Date.now();
}
function lastAssignedAt(atendenteId) {
  const e = mapa.get(atendenteId);
  return e ? e.lastAssignedAt : 0;
}

/** Info atual de um atendente na presença (matrícula + estado), ou null se ele
    nunca conectou nesta sessão do serviço — usado pela ação do gestor de forçar
    a presença (só faz sentido sobre quem está conectado). */
function infoDe(atendenteId) {
  const e = mapa.get(atendenteId);
  return e ? { matricula: e.matricula, estado: estadoDe(e) } : null;
}

/** Snapshot p/ o monitor do supervisor. */
function snapshot() {
  const out = [];
  for (const [atendenteId, e] of mapa) {
    out.push({
      atendenteId, matricula: e.matricula, nome: e.nome,
      estado: estadoDe(e), deptoIds: e.deptoIds,
    });
  }
  return out;
}

/** Sincroniza deptos/números/pausa quando o admin altera o cadastro (cache RBAC invalida). */
function atualizarPerfil(atendenteId, { deptoIds, numeroIds, pausado }) {
  const e = mapa.get(atendenteId);
  if (!e) return;
  if (deptoIds) e.deptoIds = deptoIds;
  if (numeroIds !== undefined) e.numeroIds = numeroIds || [];
  if (pausado !== undefined) e.pausado = !!pausado;
}

/** Só para testes. */
function _reset() {
  for (const [, e] of mapa) if (e.gracaTimer) clearTimeout(e.gracaTimer);
  mapa.clear();
}

module.exports = {
  conectar, desconectar, definirPausa, onlineDoDepto, numerosDe, atendeNumero,
  marcarAtribuicao, lastAssignedAt, snapshot, infoDe, atualizarPerfil,
  setAoFicarOnline, _reset, GRACA_MS,
};
