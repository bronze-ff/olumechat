// operador/segredo.js — Segredo e expiração do JWT DO OPERADOR (FIL-70).
//
// ⚠️ É UM SEGREDO DIFERENTE do JWT de tenant (auth/secret.js), e essa é a
// primeira linha de defesa da separação de sessões exigida pelo ticket: um
// token de tenant não passa nem na verificação de assinatura do painel do
// operador, e um token de operador não passa na do painel do cliente. Não é
// "ADMIN com uma flag" — são dois universos de credencial.
//
// A separação NÃO depende só disso (o middleware ainda exige o claim
// `escopo: 'operador'` e recusa token com `tenantId`), mas com segredos
// distintos nem um bug de claim reaproveita um token do outro lado.
//
// Como em auth/secret.js: em produção o boot EXIGE OPERADOR_JWT_SECRET pronto
// no ambiente (aqui é ainda mais sensível — é a credencial de super-admin);
// em dev/teste geramos um forte só em memória, nunca gravado no .env.
'use strict';
require('dotenv').config();
const crypto = require('crypto');

const { SECRET: SECRET_TENANT } = require('../auth/secret');

function gerarForte() {
  return crypto.randomBytes(48).toString('hex'); // 96 chars, 384 bits
}

let SECRET = process.env.OPERADOR_JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  const motivo = SECRET ? 'fraco/curto' : 'ausente';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[operador] OPERADOR_JWT_SECRET ${motivo} em produção — defina um segredo forte (>=32 caracteres, `
      + 'diferente do JWT_SECRET) no ambiente antes de subir. Gerar: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  SECRET = gerarForte();
  process.env.OPERADOR_JWT_SECRET = SECRET;
  console.warn(`[operador] OPERADOR_JWT_SECRET ${motivo} — usando um segredo aleatório de sessão (dev/teste; não persistido).`);
}

// Configuração idêntica nos dois lados anula a separação criptográfica: um
// token de tenant passaria a verificar como token de operador (e vice-versa).
// Não dá para "consertar" sozinho (trocar aqui derrubaria as sessões de
// tenant) — a separação das duas sessões é a fronteira do super-admin, então
// falha o boot em vez de só logar erro.
if (SECRET === SECRET_TENANT) {
  throw new Error(
    '[operador] OPERADOR_JWT_SECRET é IGUAL ao JWT_SECRET do painel do cliente — '
    + 'gere um segredo próprio para o operador (a separação de sessões depende disso).'
  );
}

// Sessão de operador é curta de propósito: é a credencial mais poderosa do
// sistema e o uso é pontual (provisionar, suspender, diagnosticar).
const EXPIRES_IN = process.env.OPERADOR_JWT_EXPIRES_IN || '2h';

module.exports = { SECRET, EXPIRES_IN };
