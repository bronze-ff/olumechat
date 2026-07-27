// auth/middleware.js — Verifica o JWT, checa a jti-blacklist e ESTABELECE A
// FRONTEIRA DE TENANT da requisição (FIL-67).
//
// ⚠️ O `tenant_id` do JWT é a fronteira de segurança de todo o sistema. A RLS
// do Postgres só isola o que `comTenant()` mandar isolar, e o que `comTenant()`
// recebe nasce AQUI. Daí as duas regras deste arquivo:
//
//  1. TOKEN SEM `tenantId` VÁLIDO É REJEITADO (401). Nunca existe "tenant
//     padrão": um token antigo, de outro emissor ou com o claim removido tem
//     que parar na porta, não cair num tenant qualquer.
//  2. O TENANT SÓ VEM DO TOKEN. Header, query string e corpo são ignorados —
//     o que este middleware escreve em `req.tenantId` é o que o resto do
//     sistema usa, e ele é sobrescrito a cada requisição. Um cliente que
//     mande `?tenant_id=2` continua preso ao tenant do seu token.
//
// DUAS CONVENÇÕES, DE PROPÓSITO: os módulos portados leem `req.tenantId`
// (conversas, campanhas, cadastros) ou `req.user.tenantId` (fila, stream,
// rbac). Este middleware alimenta AS DUAS com o mesmo valor — corrigir os
// módulos um a um seria mexer em arquivo de outro ticket, e uma divergência
// entre as duas seria justamente um buraco de isolamento.
//
//  3. SESSÃO DE SUPORTE É SOMENTE-LEITURA, E ISSO É DECIDIDO AQUI (FIL-70).
//     O operador entra num tenant com um token marcado `suporte: true`. Dar a
//     ele o papel AUDITOR não basta: AUDITOR só é barrado nas rotas que se
//     lembram de checar (`exigirPapel`, o guarda `naoAuditor` de conversas e
//     contatos) — e várias mutações não checam nada (POST/DELETE
//     /api/atalhos, PUT /api/presenca). Uma promessa de "somente-leitura" que
//     depende de cada rota lembrar é uma promessa quebrada na próxima rota
//     nova. Então o bloqueio é AQUI, no único ponto por onde toda rota de
//     tenant passa, e é FAIL-CLOSED: qualquer método que não seja de leitura
//     morre na porta, salvo uma allowlist mínima de plumbing de sessão.
'use strict';

const jwt = require('jsonwebtoken');
const blacklist = require('../utils/tokenBlacklist');
const { SECRET } = require('./secret');

/** Aceita só inteiro positivo (o id vem de `bigint GENERATED ... IDENTITY`). */
function tenantValido(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const METODOS_DE_LEITURA = new Set(['GET', 'HEAD', 'OPTIONS']);

// Únicos não-GET liberados para a sessão de suporte. Não tocam dado do tenant:
//  • /api/auth/logout   — encerrar a própria sessão precisa continuar possível;
//  • /api/stream/ticket — emite um ticket EM MEMÓRIA (auth/sseTicket.js) para
//    abrir o SSE; sem ele o operador diagnostica um inbox congelado.
// Qualquer coisa fora desta lista é 403. Acrescentar algo aqui é decisão de
// segurança, não conveniência.
const SUPORTE_LIBERADOS = new Set(['/api/auth/logout', '/api/stream/ticket']);

/** Caminho da requisição sem query string e sem barra final. */
function caminhoDaRequisicao(req) {
  const bruto = String(req.originalUrl || req.url || '').split('?')[0];
  return bruto.length > 1 ? bruto.replace(/\/+$/, '') : bruto;
}

/**
 * A requisição é permitida para uma sessão de suporte do operador?
 * Exportada para teste — a regra é curta, mas é a que sustenta a promessa de
 * "o operador diagnostica, não mexe".
 */
function leituraDeSuporte(req) {
  if (METODOS_DE_LEITURA.has(req.method)) return true;
  return SUPORTE_LIBERADOS.has(caminhoDaRequisicao(req));
}

module.exports = function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não informado' });
  }
  const token = header.slice(7);
  let decoded;
  try {
    // algorithms travado em HS256 — impede confusão de algoritmo (ex.: "none").
    decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }

  if (decoded.jti && blacklist.has(decoded.jti)) {
    return res.status(401).json({ error: 'Sessão encerrada. Faça login novamente.' });
  }

  const tenantId = tenantValido(decoded.tenantId);
  if (!tenantId) {
    // Sem tenant não há fronteira. Mesma mensagem de "token inválido": o
    // cliente não precisa saber QUAL claim faltou.
    return res.status(401).json({ error: 'Token inválido' });
  }

  // Sessão de suporte do operador: só leitura, decidido antes de qualquer
  // rota rodar (ver ponto 3 no cabeçalho).
  if (decoded.suporte === true && !leituraDeSuporte(req)) {
    return res.status(403).json({
      error: 'Sessão de suporte é somente-leitura. Peça ao cliente para executar a ação, ou use o painel do operador.',
    });
  }

  req.user = { ...decoded, tenantId };
  req.tenantId = tenantId;
  next();
};

module.exports.leituraDeSuporte = leituraDeSuporte; // uso em teste
module.exports.SUPORTE_LIBERADOS = SUPORTE_LIBERADOS;
