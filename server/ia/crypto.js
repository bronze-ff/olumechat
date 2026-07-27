// server/ia/crypto.js — cifra/decifra segredos (API keys de IA) com AES-256-GCM.
// Chave: IA_CRYPTO_KEY (dedicada e ESTÁVEL, recomendada) e, se ausente, o
// JWT_SECRET (retrocompatível). Prefira IA_CRYPTO_KEY porque o JWT_SECRET pode
// ser rotacionado pelo módulo de auth — o que tornaria a chave da API gravada
// indecifrável. A store (iaConfigStore) tolera falha de decifragem sem derrubar
// o runtime; ainda assim, o ideal é um segredo estável aqui.
'use strict';
const crypto = require('crypto');

function chaveDe(segredo) {
  const s = segredo || process.env.IA_CRYPTO_KEY || process.env.JWT_SECRET || '';
  if (!s) throw new Error('IA_CRYPTO_KEY/JWT_SECRET ausente para derivar a chave de cifragem');
  return crypto.createHash('sha256').update(s + '|ia_config').digest(); // 32 bytes
}

function criptografar(texto, segredo) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', chaveDe(segredo), iv);
  const ct = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function descriptografar(blob, segredo) {
  const [ivHex, tagHex, ctHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Blob criptografado inválido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', chaveDe(segredo), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { criptografar, descriptografar };
