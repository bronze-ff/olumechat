// scripts/carga/credencial.js — Sessões para a rampa SSE (FIL-110).
//
// ── Por que existe um caminho que não passa pelo POST /api/auth/login ──────
// O login tem limitador de 10 tentativas por 15 minutos POR IP
// (auth/routes.js::loginLimiter). Uma máquina só não consegue autenticar 200
// usuários: da 11ª em diante vem 429. Isso não é obstáculo do teste, é
// COMPORTAMENTO DO PRODUTO — está medido e registrado no relatório, e é um
// achado por si só (um escritório inteiro atrás de um NAT compartilha o teto).
//
// Para medir SSE — que é o que o ticket pede — o harness assina o mesmo JWT que
// o login assinaria, com o MESMO `JWT_SECRET` e o MESMO payload
// (auth/routes.js). Isso não afrouxa nada: exige posse do segredo do ambiente,
// que só quem opera o ambiente tem. O produto não é alterado, o middleware
// valida o token exatamente como valida o de um humano — inclusive a consulta
// à jti-blacklist, que é parte do custo por requisição que se quer medir.
//
// O custo do login continua sendo medido de verdade: a rampa faz os primeiros
// logins pelo endpoint real (dentro do teto do limitador) e reporta a latência
// do argon2id à parte.
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

/** `jsonwebtoken` vem de server/node_modules — é a mesma versão que o produto assina. */
function jwtDoServer() {
  return require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'jsonwebtoken'));
}

/**
 * Assina um token equivalente ao que `POST /api/auth/login` devolveria.
 * @param {{tenantId:number, usuarioId:number, nome?:string, email?:string}} dados
 */
function assinarToken(dados, { segredo = process.env.JWT_SECRET, validade = process.env.JWT_EXPIRES_IN || '8h' } = {}) {
  if (!segredo) {
    throw new Error('JWT_SECRET ausente: exporte o segredo do ambiente alvo ou rode sem --token-local.');
  }
  const jwt = jwtDoServer();
  return jwt.sign({
    jti: crypto.randomUUID(),
    tenantId: dados.tenantId,
    usuarioId: dados.usuarioId,
    matricula: dados.usuarioId, // convenção da migração 004
    nome: dados.nome || null,
    email: dados.email || null,
  }, segredo, { expiresIn: validade });
}

module.exports = { assinarToken };
