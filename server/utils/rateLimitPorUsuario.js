// utils/rateLimitPorUsuario.js — fábrica de rate limit por USUÁRIO autenticado
// (tenantId + matrícula), não só por IP. Usado nas rotas que custam dinheiro
// real por chamada (sugestão de IA, envio pela Cloud API da Meta): um teto por
// IP sozinho deixaria vários usuários atrás do mesmo NAT/proxy corporativo
// dividirem o mesmo limite, e não impede um único usuário trocando de IP.
'use strict';

const rateLimit = require('express-rate-limit');

// Atrás de um proxy o X-Forwarded-For pode chegar com PORTA ("172.16.0.1:61727")
// e a lib rejeita (ERR_ERL_INVALID_IP_ADDRESS). Mesmo tratamento do auth/routes.js.
function chavePorIp(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return m ? m[1] : ip;
}

/** Chave por usuário DENTRO do tenant (mesmo par usado no cache do RBAC — ver
 *  auth/rbac.js). Cai para IP só se a rota for alcançada sem perfil autenticado
 *  (não deveria acontecer atrás de authMiddleware; evita chave global `undefined`). */
function chavePorUsuario(req) {
  const tenantId = req.tenantId ?? (req.user && req.user.tenantId);
  const usuario = req.user && (req.user.matricula ?? req.user.usuarioId);
  return usuario != null ? `u:${tenantId}:${usuario}` : `ip:${chavePorIp(req)}`;
}

/** @param {{windowMs:number, max:number, mensagem?:string}} opts */
function limiterPorUsuario({ windowMs, max, mensagem }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: chavePorUsuario,
    validate: { trustProxy: false },
    // JSON, não o texto padrão da lib: o front lê `error` de todas as respostas de /api.
    message: { error: mensagem || 'Muitas requisições em pouco tempo. Aguarde um instante.' },
  });
}

module.exports = { chavePorUsuario, limiterPorUsuario };
