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
'use strict';

const jwt = require('jsonwebtoken');
const blacklist = require('../utils/tokenBlacklist');
const { SECRET } = require('./secret');

/** Aceita só inteiro positivo (o id vem de `bigint GENERATED ... IDENTITY`). */
function tenantValido(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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

  req.user = { ...decoded, tenantId };
  req.tenantId = tenantId;
  next();
};
