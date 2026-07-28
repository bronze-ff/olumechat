// utils/rateLimitPorUsuario.js — fábrica de rate limit por USUÁRIO autenticado
// (tenantId + matrícula), não só por IP. Usado nas rotas que custam dinheiro
// real por chamada (sugestão de IA, envio pela Cloud API da Meta): um teto por
// IP sozinho deixaria vários usuários atrás do mesmo NAT/proxy corporativo
// dividirem o mesmo limite, e não impede um único usuário trocando de IP.
//
// Sessão de suporte do operador (FIL-70) não tem `matricula` nem `usuarioId`
// — só `operadorId` (não é gente do cliente). Sem esse fallback, ela caía
// direto no bucket por IP: vários operadores atrás do mesmo NAT dividiriam a
// mesma cota, e um operador trocando de IP escapava dela. Prioridade da
// chave: usuário do tenant (matricula/usuarioId) → operador de suporte
// (operadorId) → IP, só quando nenhum dos dois existe.
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
 *  auth/rbac.js). Sessão de suporte (sem matrícula/usuarioId) cai para o
 *  operadorId, escopado ao tenant — não para o IP. Só cai para IP se a rota
 *  for alcançada sem perfil autenticado nenhum (não deveria acontecer atrás
 *  de authMiddleware; evita chave global `undefined`). */
function chavePorUsuario(req) {
  const tenantId = req.tenantId ?? (req.user && req.user.tenantId);
  const usuario = req.user && (req.user.matricula ?? req.user.usuarioId);
  if (usuario != null) return `u:${tenantId}:${usuario}`;
  const operadorId = req.user && req.user.operadorId;
  if (operadorId != null) return `op:${tenantId}:${operadorId}`;
  return `ip:${chavePorIp(req)}`;
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
