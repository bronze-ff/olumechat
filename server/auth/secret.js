// auth/secret.js — segredo e expiração do JWT (uma fonte só).
// SEGURANÇA: nunca usar um segredo fixo/embutido no código (seria público e
// permitiria forjar tokens). Se o JWT_SECRET estiver ausente ou fraco (<32):
// em PRODUÇÃO o boot falha imediatamente — container é descartável, um
// segredo gerado-e-gravado ali morre no próximo redeploy (ou, pior, cada
// réplica geraria o seu e derrubaria sessão de usuário aleatoriamente); em
// dev/teste geramos um FORTE em memória, nunca gravado no .env (senão os
// testes, que requerem este módulo, sobrescreveriam o .env real).
'use strict';
require('dotenv').config(); // auto-suficiente (idempotente; não sobrescreve vars já definidas)
const crypto = require('crypto');

function gerarForte() {
  return crypto.randomBytes(48).toString('hex'); // 96 chars, 384 bits
}

let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  const motivo = SECRET ? 'fraco/curto' : 'ausente';
  if (process.env.NODE_ENV === 'production') {
    // Mesmo padrão do db/pool.js::initPool p/ config crítica ausente/quebrada:
    // falha o boot em vez de inventar um segredo que não sobrevive a um restart.
    throw new Error(
      `[auth] JWT_SECRET ${motivo} em produção — defina um segredo forte (>=32 caracteres) no `
      + 'ambiente antes de subir. Gerar: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  SECRET = gerarForte();
  process.env.JWT_SECRET = SECRET;
  console.warn(`[auth] JWT_SECRET ${motivo} — usando um segredo aleatório de sessão (dev/teste; não persistido).`);
}

const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

module.exports = { SECRET, EXPIRES_IN };
