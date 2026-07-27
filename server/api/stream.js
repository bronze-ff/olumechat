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
// portado) também é descartado, nunca vaza por omissão — e é LOGADO (não
// silenciado), porque um publisher esquecido vira "o inbox parou de
// atualizar" sem pista nenhuma no log. Ver a lista de publishers de outros
// módulos que ainda não etiquetam (api/contatos.js, api/conversas.js,
// bot/runtime.js, campanha/dispatcher.js, webhook/processEvent.js) no corpo
// do PR #7 — até essas portes tageiarem, os eventos deles somem daqui (log
// avisa; não é um crash, é o gate fazendo o trabalho dele mais cedo do que
// o resto do sistema está pronto pra ele).
//
// tenantId vem do ticket (que carrega req.user por inteiro — ver POST
// /ticket) — mesmo contrato do JWT que FIL-59 estabeleceu para
// auth/rbac.carregarPerfil(tenantId, matricula, nome): quem emite o token é
// quem decide o tenant, não uma consulta feita aqui.
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
  if (!user.tenantId) return res.status(401).json({ error: 'Ticket sem tenant associado' });
  const tenantId = user.tenantId;

  // Perfil para filtrar eventos + registrar presença.
  let perfil;
  try {
    perfil = await carregarPerfil(tenantId, user.matricula, user.nome);
  } catch (err) {
    console.error('[stream] falha ao carregar perfil:', err.message);
    return res.status(500).json({ error: 'Falha ao carregar perfil' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // desliga buffering em proxies (nginx/IIS)
  });
  res.write('retry: 5000\n\n');            // o navegador reconecta em 5s se cair
  res.write('event: ready\ndata: {}\n\n'); // sinaliza conexão pronta

  const enviar = (evt) => {
    if (evt.tenantId === undefined) {
      // Descarta (fail-closed) — mas AVISA: isso é sinal de publisher que
      // ainda não tageia tenantId, não de tráfego cross-tenant normal (ver
      // cabeçalho do arquivo). Ajuda a achar o módulo esquecido em produção.
      console.warn(`[stream] evento "${evt.tipo}" sem tenantId descartado — publisher não tageia tenant?`);
      return;
    }
    if (evt.tenantId !== tenantId) return; // outro tenant — tráfego normal do hub compartilhado, não loga
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
