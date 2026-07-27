// operador/middleware.js — A PORTA DO PAINEL DO OPERADOR (FIL-70).
//
// ⚠️ Este painel ignora a RLS por natureza: ele enxerga todos os tenants. É o
// alvo mais valioso do sistema. Por isso ele tem middleware PRÓPRIO — nunca
// reaproveita `auth/middleware.js` — e a separação é em três camadas:
//
//   1. SEGREDO DIFERENTE. O token de operador é assinado com
//      OPERADOR_JWT_SECRET (operador/segredo.js). Um JWT de tenant nem chega a
//      passar na verificação de assinatura aqui.
//   2. CLAIM DE ESCOPO. Só passa token com `escopo: 'operador'` e
//      `operadorId`. E token que traga `tenantId` é RECUSADO mesmo assinado
//      com o segredo certo — um token de operador não tem tenant; se tem, é
//      sessão de suporte, que vale no painel do CLIENTE, não aqui.
//   3. CONTA VIVA. O operador é reconferido no banco a cada requisição
//      (`ativo = 'S'`). Desativar um operador tem efeito imediato, não "quando
//      o JWT expirar".
//
// ── POR QUE 403 (E NÃO 401) PARA TOKEN DE TENANT ────────────────────────────
// O critério de aceite do ticket é explícito: um JWT de ADMIN de tenant recebe
// 403 em TODA rota /api/operador/*. 401 significaria "identifique-se" — e o
// ADMIN JÁ está identificado; o que falta é autorização, que ele nunca vai
// ter. Para dar essa resposta, quando a verificação com o segredo do operador
// falha, tentamos verificar com o segredo do TENANT: se o token é um token de
// tenant legítimo, respondemos 403. Qualquer outra coisa (lixo, expirado,
// forjado) continua 401.
'use strict';

const jwt = require('jsonwebtoken');

const blacklist = require('../utils/tokenBlacklist');
const { SECRET } = require('./segredo');
const { SECRET: SECRET_TENANT } = require('../auth/secret');
const contas = require('./contas');

const MSG_401 = 'Sessão de operador inválida ou expirada.';
const MSG_403 = 'Esta área é exclusiva do operador do Falatta. Sua sessão é de um cliente.';

/** Aceita só inteiro positivo (o id vem de `bigint GENERATED ... IDENTITY`). */
function idValido(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** É um JWT de TENANT legítimo? (só para escolher entre 403 e 401) */
function ehTokenDeTenant(token) {
  try {
    const d = jwt.verify(token, SECRET_TENANT, { algorithms: ['HS256'] });
    return !!idValido(d && d.tenantId);
  } catch {
    return false;
  }
}

module.exports = async function autenticarOperador(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não informado' });
  }
  const token = header.slice(7);

  let decoded = null;
  try {
    decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  } catch {
    // Assinatura não confere (ou expirou). Se for um token de tenant válido, o
    // problema é de AUTORIZAÇÃO — ver cabeçalho.
    return ehTokenDeTenant(token)
      ? res.status(403).json({ error: MSG_403 })
      : res.status(401).json({ error: MSG_401 });
  }

  // Assinado com o segredo do operador, mas sem cara de sessão de operador.
  // Cobre também o caso de OPERADOR_JWT_SECRET ter sido configurado igual ao
  // JWT_SECRET: um token de tenant passaria na assinatura e morre aqui.
  if (!Number.isFinite(decoded.exp)) {
    return res.status(401).json({ error: MSG_401 });
  }

  const operadorId = idValido(decoded.operadorId);
  if (decoded.escopo !== 'operador' || !operadorId) {
    return ehTokenDeTenant(token)
      ? res.status(403).json({ error: MSG_403 })
      : res.status(401).json({ error: MSG_401 });
  }
  // Token de operador NÃO carrega tenant. Se carrega, é sessão de suporte —
  // que serve para entrar no painel do CLIENTE, não para voltar aqui e agir
  // sobre todos os tenants com um token de alcance reduzido.
  if (decoded.tenantId !== undefined && decoded.tenantId !== null) {
    return res.status(403).json({ error: MSG_403 });
  }
  try {
    if (decoded.jti && await blacklist.has(decoded.jti, { operador: true })) {
      return res.status(401).json({ error: 'Sessão encerrada. Faça login novamente.' });
    }
    const operador = await contas.buscarAtivoPorId(operadorId);
    if (!operador) return res.status(401).json({ error: MSG_401 });
    req.operador = { ...operador, jti: decoded.jti, exp: decoded.exp };
    next();
  } catch (err) {
    next(err);
  }
};
