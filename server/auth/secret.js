// auth/secret.js — segredo e expiração do JWT (uma fonte só).
// SEGURANÇA: nunca usar um segredo fixo/embutido no código (seria público e
// permitiria forjar tokens). Se o JWT_SECRET estiver ausente ou fraco (<32),
// geramos um FORTE (crypto). Em PRODUÇÃO persistimos no .env (estável entre
// reinícios); em dev/teste NÃO escrevemos no .env (senão os testes, que
// requerem este módulo, sobrescreveriam o .env real).
'use strict';
require('dotenv').config(); // auto-suficiente (idempotente; não sobrescreve vars já definidas)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function gerarForte() {
  return crypto.randomBytes(48).toString('hex'); // 96 chars, 384 bits
}

/** Grava (ou substitui) a linha JWT_SECRET no .env e aperta a permissão p/ 0600. */
function persistir(valor) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let txt = '';
    try { txt = fs.readFileSync(envPath, 'utf8'); } catch { /* .env ainda não existe */ }
    if (/^JWT_SECRET=.*$/m.test(txt)) {
      txt = txt.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${valor}`);
    } else {
      txt += (txt && !txt.endsWith('\n') ? '\n' : '') + `JWT_SECRET=${valor}\n`;
    }
    fs.writeFileSync(envPath, txt);
    try { fs.chmodSync(envPath, 0o600); } catch { /* fs sem suporte a chmod (Windows) */ }
    return true;
  } catch (e) {
    console.error('[auth] não consegui persistir JWT_SECRET no .env:', e.message);
    return false;
  }
}

let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  const motivo = SECRET ? 'fraco/curto' : 'ausente';
  SECRET = gerarForte();
  process.env.JWT_SECRET = SECRET;
  if (process.env.NODE_ENV === 'production') {
    const ok = persistir(SECRET);
    if (!ok) {
      // Sem persistir, CADA RÉPLICA gera o próprio segredo em memória — elas
      // assinam diferente entre si e derrubam sessão de usuário aleatoriamente
      // a cada deploy/restart (um token válido na réplica A vira 401 na B).
      // Falha o boot: mesmo padrão do db/pool.js::initPool p/ config crítica
      // ausente/quebrada.
      throw new Error(
        '[auth] JWT_SECRET ausente e não foi possível persistir um novo em produção '
        + '(container com FS read-only?) — defina JWT_SECRET no ambiente antes de subir.'
      );
    }
    console.warn(`[auth] JWT_SECRET ${motivo} — gerado um forte automaticamente e gravado no .env.`);
  } else {
    console.warn(`[auth] JWT_SECRET ${motivo} — usando um segredo aleatório de sessão (dev/teste; não persistido).`);
  }
}

const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

module.exports = { SECRET, EXPIRES_IN };
