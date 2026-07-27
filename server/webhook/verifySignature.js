// webhook/verifySignature.js — Valida o header X-Hub-Signature-256.
// = 'sha256=' + HMAC-SHA256(appSecret, rawBody), com comparação em tempo
// constante (timingSafeEqual) para evitar timing attacks. (PRD §5.3, RF-43)
const crypto = require('crypto');

/**
 * @param {Buffer} rawBody    Corpo bruto da requisição (req.rawBody).
 * @param {string} signature  Valor do header 'x-hub-signature-256'.
 * @param {string} appSecret  Chave Secreta do App (Meta).
 * @returns {boolean} true se a assinatura confere.
 */
function isValidSignature(rawBody, signature, appSecret) {
  if (!signature || !rawBody) return false;
  if (!signature.startsWith('sha256=')) return false;

  const expected = 'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;       // timingSafeEqual exige tamanhos iguais
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isValidSignature };
