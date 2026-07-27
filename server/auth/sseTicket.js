// auth/sseTicket.js — Tickets de uso único para abrir o stream SSE.
// O EventSource do navegador não permite enviar o header Authorization, e pôr
// o JWT na query vazaria nos logs de acesso. Então o cliente (já autenticado)
// pede um ticket curto via POST /api/stream/ticket e o usa uma única vez na
// URL do EventSource. Armazenado em memória (processo único).
'use strict';

const crypto = require('crypto');

const TTL_MS = 30_000; // 30s para abrir a conexão
const tickets = new Map(); // ticket -> { user, exp }

/** Cria um ticket para o usuário; expira em 30s e é consumido no uso. */
function criarTicket(user) {
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { user, exp: Date.now() + TTL_MS });
  return ticket;
}

/** Valida e CONSOME o ticket (uso único). Devolve o user ou null. */
function consumirTicket(ticket) {
  const item = tickets.get(ticket);
  if (!item) return null;
  tickets.delete(ticket);
  if (item.exp < Date.now()) return null;
  return item.user;
}

// Limpeza periódica de tickets expirados (não vaza memória).
const timer = setInterval(() => {
  const agora = Date.now();
  for (const [t, item] of tickets) if (item.exp < agora) tickets.delete(t);
}, 60_000);
if (timer.unref) timer.unref();

module.exports = { criarTicket, consumirTicket };
