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
//     O operador entra em UM tenant escolhido com um token curto marcado
//     `suporte: true`. A fronteira continua sendo o tenantId assinado no token,
//     mas a sessão existe para DIAGNOSTICAR, não para mexer no tenant do
//     cliente. Dar a ela um papel administrativo não basta: uma checagem de
//     papel só barra nas rotas que se lembram de checar (`exigirPapel`) — e
//     várias mutações não checam papel nenhum (POST/DELETE /api/atalhos, PUT
//     /api/presenca). Uma promessa de "somente-leitura" que depende de cada
//     rota lembrar é uma promessa quebrada na próxima rota nova. Então o
//     bloqueio é AQUI, no único ponto por onde toda rota de tenant passa, e é
//     FAIL-CLOSED: qualquer método que não seja de leitura morre na porta,
//     salvo uma allowlist mínima e explícita. Toda tentativa de escrita —
//     inclusive as bloqueadas — é auditada, para o cliente enxergar o que o
//     operador tentou.
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

/**
 * Allowlist mínima e explícita de mutações liberadas para a sessão de
 * suporte. Caminho exato — sem casar por prefixo, query string ou barra
 * final (`caminhoDaRequisicao()` já normaliza isso). Cada entrada existe por
 * um motivo pontual comentado abaixo.
 *
 * ACRESCENTAR ROTA AQUI É DECISÃO DE SEGURANÇA E PASSA POR REVIEW — não é
 * conveniência. Toda rota fora desta lista morre em 403 na porta.
 */
const SUPORTE_LIBERADOS = [
  // Ticket SSE: emite um valor efêmero em memória (auth/sseTicket.js) para
  // abrir o SSE; sem ele o operador não diagnostica um inbox congelado.
  { metodo: 'POST', caminho: '/api/stream/ticket' },
  // Encerrar a própria sessão precisa continuar possível.
  { metodo: 'POST', caminho: '/api/auth/logout' },
  // Provisionamento de canal: EXIGE sessão de suporte (ver
  // `exigirSuporteOperador` em api/numeros.js e api/meta.js) — o cliente não
  // tem credenciais/IDs da Meta, e conectar o canal é justamente para isso
  // que a sessão de suporte existe.
  { metodo: 'POST', caminho: '/api/numeros' },
  { metodo: 'PUT', caminho: /^\/api\/numeros\/\d+$/ },
  { metodo: 'POST', caminho: /^\/api\/numeros\/\d+\/registrar$/ },
  { metodo: 'POST', caminho: '/api/meta/signup/exchange' },
];

function liberadoParaSuporte(req) {
  const caminho = caminhoDaRequisicao(req);
  return SUPORTE_LIBERADOS.some(({ metodo, caminho: alvo }) => {
    if (metodo !== req.method) return false;
    return typeof alvo === 'string' ? alvo === caminho : alvo.test(caminho);
  });
}

/**
 * A requisição é permitida para uma sessão de suporte do operador?
 * Exportada para teste — é a regra que sustenta a promessa de "o operador
 * diagnostica, não mexe" (salvo o provisionamento de canal, que é a exceção
 * deliberada da allowlist acima).
 */
function leituraDeSuporte(req) {
  if (METODOS_DE_LEITURA.has(req.method)) return true;
  return liberadoParaSuporte(req);
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
    // Deny central, fail-closed: decidido AQUI, antes de qualquer rota rodar
    // (ver ponto 3 no cabeçalho). Depois da auditoria — a tentativa bloqueada
    // também fica registrada.
    if (!leituraDeSuporte(req)) {
      return res.status(403).json({
        error: 'Sessão de suporte é somente-leitura. Peça ao cliente para executar a ação, ou use o painel do operador.',
      });
    }
  }
  next();
};

module.exports.mutacaoDeSuporte = mutacaoDeSuporte;
module.exports.auditarMutacaoDeSuporte = auditarMutacaoDeSuporte;
module.exports.leituraDeSuporte = leituraDeSuporte;
module.exports.SUPORTE_LIBERADOS = SUPORTE_LIBERADOS;
