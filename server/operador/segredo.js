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
// Como em auth/secret.js: sem OPERADOR_JWT_SECRET (ou com um fraco), geramos
// um forte. Em produção ele é persistido no .env; em dev/teste não (senão a
// suíte reescreveria o .env real).
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { SECRET: SECRET_TENANT } = require('../auth/secret');

function gerarForte() {
  return crypto.randomBytes(48).toString('hex'); // 96 chars, 384 bits
}

/** Grava (ou substitui) a linha OPERADOR_JWT_SECRET no .env, com modo 0600. */
function persistir(valor) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let txt = '';
    try { txt = fs.readFileSync(envPath, 'utf8'); } catch { /* .env ainda não existe */ }
    if (/^OPERADOR_JWT_SECRET=.*$/m.test(txt)) {
      txt = txt.replace(/^OPERADOR_JWT_SECRET=.*$/m, `OPERADOR_JWT_SECRET=${valor}`);
    } else {
      txt += (txt && !txt.endsWith('\n') ? '\n' : '') + `OPERADOR_JWT_SECRET=${valor}\n`;
    }
    fs.writeFileSync(envPath, txt);
    try { fs.chmodSync(envPath, 0o600); } catch { /* fs sem suporte a chmod (Windows) */ }
    return true;
  } catch (e) {
    console.error('[operador] não consegui persistir OPERADOR_JWT_SECRET no .env:', e.message);
    return false;
  }
}

let SECRET = process.env.OPERADOR_JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  const motivo = SECRET ? 'fraco/curto' : 'ausente';
  SECRET = gerarForte();
  process.env.OPERADOR_JWT_SECRET = SECRET;
  if (process.env.NODE_ENV === 'production') {
    const ok = persistir(SECRET);
    if (!ok) {
      // Mesmo risco do auth/secret.js: sem persistir, cada réplica assina
      // diferente e derruba sessão de operador aleatoriamente. Aqui é ainda
      // mais sensível — é a credencial de super-admin.
      throw new Error(
        '[operador] OPERADOR_JWT_SECRET ausente e não foi possível persistir um novo em produção '
        + '(container com FS read-only?) — defina OPERADOR_JWT_SECRET no ambiente antes de subir.'
      );
    }
    console.warn(`[operador] OPERADOR_JWT_SECRET ${motivo} — gerado um forte automaticamente e gravado no .env.`);
  } else {
    console.warn(`[operador] OPERADOR_JWT_SECRET ${motivo} — usando um segredo aleatório de sessão (dev/teste; não persistido).`);
  }
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
