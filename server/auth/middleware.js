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
//  3. SESSÃO DE SUPORTE TEM CRUD COMPLETO, E ISSO É DECISÃO DE PRODUTO (FIL-70).
//     O operador entra em UM tenant escolhido com um token curto marcado
//     `suporte: true`, para IMPLANTAR e CONFIGURAR o tenant de clientes que não
//     têm equipe técnica própria: criar departamentos, atendentes, fluxos,
//     tags, atalhos, ajustar configurações, campanhas, IA — o mesmo CRUD de um
//     ADMIN do cliente que logou com email e senha próprios. NENHUMA rota
//     diferencia suporte de ADMIN em permissão (as poucas exceções pontuais,
//     como `exigirSuporteOperador` em api/numeros.js/meta.js, vão no sentido
//     contrário: restringem o ADMIN comum, não o suporte).
//     A CONTRAPARTIDA DESSE PODER, NÃO UM SUBSTITUTO DELE, É A AUDITORIA:
//     toda mutação de uma sessão de suporte é registrada AQUI, antes da rota,
//     inclusive nas rotas que não têm auditoria própria — e cai na trilha que
//     o PRÓPRIO CLIENTE lê no painel dele. Não reintroduza um bloqueio central
//     de escrita aqui sem alinhar com produto: já foi tentado (FIL-70 original
//     e uma reversão temporária deste ticket) e revertido nas duas vezes.
'use strict';

const jwt = require('jsonwebtoken');
const blacklist = require('../utils/tokenBlacklist');
const db = require('../db/pool');
const { SECRET } = require('./secret');

/** Aceita só inteiro positivo (o id vem de `bigint GENERATED ... IDENTITY`). */
function tenantValido(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const METODOS_DE_LEITURA = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Caminho da requisição sem query string e sem barra final. */
function caminhoDaRequisicao(req) {
  const bruto = String(req.originalUrl || req.url || '').split('?')[0];
  return bruto.length > 1 ? bruto.replace(/\/+$/, '') : bruto;
}

function mutacaoDeSuporte(req) {
  if (METODOS_DE_LEITURA.has(req.method)) return false;
  // Ticket SSE só cria um valor efêmero em memória; não altera o cliente e
  // ocorre a cada reconexão, portanto não deve poluir a auditoria.
  return caminhoDaRequisicao(req) !== '/api/stream/ticket';
}

async function auditarMutacaoDeSuporte(req, decoded, tenantId) {
  if (!mutacaoDeSuporte(req)) return;
  const caminho = caminhoDaRequisicao(req);
  await db.comTenant(tenantId, (conn) => conn.execute(
    `INSERT INTO auditoria (acao, entidade, entidade_id, detalhe, ip)
     VALUES (:acao, 'operador', :op, :det, :ip)`,
    {
      acao: 'suporte_mutacao',
      op: decoded.operadorId || null,
      det: JSON.stringify({
        operadorId: decoded.operadorId || null,
        operador: decoded.email || null,
        metodo: req.method,
        caminho,
      }),
      ip: req.ip || null,
    }
  ));
}

module.exports = async function auth(req, res, next) {
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

  // Tokens without `exp` cannot be safely revoked: the blacklist entry would
  // expire immediately while the JWT itself would remain valid.
  if (!Number.isFinite(decoded.exp)) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const tenantId = tenantValido(decoded.tenantId);
  if (!tenantId) {
    // Sem tenant não há fronteira. Mesma mensagem de "token inválido": o
    // cliente não precisa saber QUAL claim faltou.
    return res.status(401).json({ error: 'Token inválido' });
  }

  try {
    if (decoded.jti && await blacklist.has(decoded.jti, { tenantId })) {
      return res.status(401).json({ error: 'Sessão encerrada. Faça login novamente.' });
    }
  } catch (err) {
    return next(err);
  }

  req.user = { ...decoded, tenantId };
  req.tenantId = tenantId;
  if (decoded.suporte === true) {
    try {
      await auditarMutacaoDeSuporte(req, decoded, tenantId);
    } catch (err) {
      return next(err);
    }
  }
  next();
};

module.exports.mutacaoDeSuporte = mutacaoDeSuporte;
module.exports.auditarMutacaoDeSuporte = auditarMutacaoDeSuporte;
