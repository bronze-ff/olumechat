// api/stream.js — Tempo-real via Server-Sent Events (SSE).
// POST /api/stream/ticket  → (autenticado) devolve um ticket curto.
// GET  /api/stream?ticket= → abre o stream; repassa os eventos do hub
//                            FILTRADOS pelo perfil (departamentos/papel) e
//                            registra a PRESENÇA do atendente (Fase 5B).
//
// MULTI-TENANT: o hub (realtime/hub.js) continua um EventEmitter local sem
// noção de tenant — quem publica evento tageia `evento.tenantId` na origem
// (fila/distribuidor.js, realtime/presence.js) e o filtro aqui é o gate final
// e OBRIGATÓRIO: evt.tenantId !== tenantId do assinante → descarta, sempre,
// antes de qualquer outra regra de escopo (inclusive antes do bypass de
// ADMIN/AUDITOR em podeReceber — "vê tudo" nunca pode significar "vê tudo de
// todo mundo"). Fail-closed: evento sem tenantId (publicador ainda não
// portado) também é descartado, nunca vaza por omissão.
'use strict';

const express = require('express');
const authMiddleware = require('../auth/middleware');
const { criarTicket, consumirTicket } = require('../auth/sseTicket');
const { subscribe } = require('../realtime/hub');
const presence = require('../realtime/presence');
const { carregarPerfil } = require('../auth/rbac');

const router = express.Router();

// Emite um ticket de uso único (cliente já autenticado por JWT).
router.post('/ticket', authMiddleware, (req, res) => {
  res.json({ ticket: criarTicket(req.user || {}) });
});

/**
 * Decide se o evento vai para este cliente.
 * ADMIN/AUDITOR veem tudo; SUPERVISOR/ATENDENTE veem o que é dos seus
 * departamentos, o que está atribuído a eles e o que não tem departamento
 * (inbox geral). Presença é visível a todos (alimenta o monitor/UI).
 */
function podeReceber(perfil, evt) {
  if (perfil.papel === 'ADMIN' || perfil.papel === 'AUDITOR') return true;
  if (evt.tipo === 'presenca') return true;
  if (evt.atendenteId && evt.atendenteId === perfil.atendenteId) return true;
  // Escopo por departamento.
  const deptoOk = evt.departamentoId == null || perfil.deptoIds.includes(evt.departamentoId);
  if (!deptoOk) return false;
  // Escopo por NÚMERO (canal): atendente restrito não é notificado de conversa
  // de número fora do seu acesso — evita o "bip" da fila ativa chegar na receptiva.
  const meusNum = perfil.numeroIds || [];
  if (meusNum.length && evt.numeroId && !meusNum.includes(evt.numeroId)) return false;
  return true;
}

// Abre a conexão SSE. Sem auth global: valida o ticket aqui.
router.get('/', async (req, res) => {
  const user = consumirTicket(req.query.ticket);
  if (!user) return res.status(401).json({ error: 'Ticket inválido ou expirado' });

  // Perfil para filtrar eventos + registrar presença.
  let perfil;
  try {
    perfil = await carregarPerfil(user.matricula, user.nome);
  } catch (err) {
    console.error('[stream] falha ao carregar perfil:', err.message);
    return res.status(500).json({ error: 'Falha ao carregar perfil' });
  }

  let tenantId;
  try {
    tenantId = await presence.tenantDoAtendente(perfil.atendenteId);
  } catch (err) {
    console.error('[stream] falha ao resolver tenant:', err.message);
    return res.status(500).json({ error: 'Falha ao resolver tenant' });
  }
  if (!tenantId) return res.status(401).json({ error: 'Atendente sem tenant associado' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // desliga buffering em proxies (nginx/IIS)
  });
  res.write('retry: 5000\n\n');            // o navegador reconecta em 5s se cair
  res.write('event: ready\ndata: {}\n\n'); // sinaliza conexão pronta

  const enviar = (evt) => {
    if (evt.tenantId !== tenantId) return; // isolamento de tenant — nunca vaza (ver cabeçalho)
    if (podeReceber(perfil, evt)) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  const cancelar = subscribe(enviar);

  // Presença: conexão SSE conta como "online" (pausa persistida no banco).
  presence.conectar({
    atendenteId: perfil.atendenteId,
    tenantId,
    deptoIds: perfil.deptoIds,
    numeroIds: perfil.numeroIds,
    matricula: user.matricula,
    nome: user.nome,
    pausado: perfil.pausado, // pausa persistida sobrevive a restart/refresh
  });

  // Heartbeat para manter a conexão viva atrás de proxies.
  const hb = setInterval(() => res.write(': ping\n\n'), 25_000);
  if (hb.unref) hb.unref();

  req.on('close', () => {
    clearInterval(hb);
    cancelar();
    presence.desconectar(perfil.atendenteId);
  });
});

module.exports = router;
module.exports.podeReceber = podeReceber; // uso em teste
