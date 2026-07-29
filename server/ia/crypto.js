// server/ia/crypto.js — cifra/decifra segredos (API keys de IA) com AES-256-GCM.
// Chave: IA_CRYPTO_KEY (dedicada e ESTÁVEL, recomendada) e, se ausente, o
// JWT_SECRET (retrocompatível). Prefira IA_CRYPTO_KEY porque o JWT_SECRET pode
// ser rotacionado pelo módulo de auth — o que tornaria a chave da API gravada
// indecifrável. A store (iaConfigStore) tolera falha de decifragem sem derrubar
// o runtime; ainda assim, o ideal é um segredo estável aqui.
//
// CHAVE POR TENANT (FIL-63): a chave é derivada do segredo mestre + tenantId,
// não só do segredo mestre. A RLS já impede o tenant B de LER a linha do
// tenant A pelo app — isto é defesa em profundidade: mesmo que o blob cifrado
// vaze por outro caminho (RLS mal configurada, dump, log, backup), decifrá-lo
// exige saber o tenant a que ele pertence, não só o segredo mestre global.
// Não muda o algoritmo (AES-256-GCM segue igual) — só o material de entrada
// do hash que vira a chave. Segredo por tenant armazenado no banco (chave que
// nem o segredo mestre sozinho decifra) foi avaliado e adiado para um ticket
// futuro de provisionamento (FIL-70).
'use strict';
const crypto = require('crypto');

// FIL-93 (P0.5): em produção o boot EXIGE IA_CRYPTO_KEY explícito — o
// fallback para JWT_SECRET abaixo continua existindo só para dev/teste.
// Calculado uma vez no load do módulo (mesmo padrão do auth/secret.js e do
// storage/index.js) para o erro aparecer assim que o processo sobe, não na
// primeira cifragem.
//
// Achado de review P2 (Codex, PR #39): checar só presença deixava "x" ou um
// espaço em branco passarem. Mesmo padrão de comprimento mínimo do
// auth/secret.js e do operador/segredo.js (>=32 caracteres, medidos depois
// do trim — "presente" não é o mesmo que "forte").
const IA_CRYPTO_KEY_TRIM = (process.env.IA_CRYPTO_KEY || '').trim();
if (!IA_CRYPTO_KEY_TRIM || IA_CRYPTO_KEY_TRIM.length < 32) {
  const motivo = IA_CRYPTO_KEY_TRIM ? 'fraco/curto' : 'ausente';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[ia] IA_CRYPTO_KEY ${motivo} em produção — sem uma chave forte (>=32 caracteres) e dedicada, `
      + 'credenciais de IA/Meta cifradas por tenant ficam reféns de rotação do JWT_SECRET. Defina '
      + 'IA_CRYPTO_KEY no ambiente antes de subir. Gerar: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  console.warn(`[ia] IA_CRYPTO_KEY ${motivo} — usando fallback JWT_SECRET (dev/teste; não use em produção).`);
}

function chaveDe(tenantId, segredo, contexto = 'ia_config') {
  const s = segredo || process.env.IA_CRYPTO_KEY || process.env.JWT_SECRET || '';
  if (!s) throw new Error('IA_CRYPTO_KEY/JWT_SECRET ausente para derivar a chave de cifragem');
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    throw new Error('chaveDe: tenantId obrigatório — a chave é derivada por tenant');
  }
  return crypto.createHash('sha256').update(`${s}|${contexto}|${tenantId}`).digest(); // 32 bytes
}

function criptografar(texto, tenantId, segredo, contexto = 'ia_config') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', chaveDe(tenantId, segredo, contexto), iv);
  const ct = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function abrir(chave, iv, tag, ct) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', chave, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function descriptografar(blob, tenantId, segredo, contexto = 'ia_config') {
  const [ivHex, tagHex, ctHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Blob criptografado inválido');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  try {
    return abrir(chaveDe(tenantId, segredo, contexto), iv, tag, ct);
  } catch (erroPrimario) {
    // FIL-93 (review P1): antes deste ticket, chaveDe() caía DIRETO no
    // JWT_SECRET quando IA_CRYPTO_KEY não existia — todo blob gravado nessa
    // época (inclusive em bancos de produção já em uso) foi cifrado com
    // aquela chave. Passar a exigir IA_CRYPTO_KEY não pode tornar esses
    // blobs indecifráveis. Só tenta o caminho legado quando (a) o chamador
    // não fixou um segredo explícito — isso é só o env real, nunca teste —
    // e (b) existe de fato uma IA_CRYPTO_KEY "nova" hoje (senão a chave
    // primária JÁ é o JWT_SECRET e não há um caminho "legado" distinto).
    if (segredo || !process.env.IA_CRYPTO_KEY || !process.env.JWT_SECRET) throw erroPrimario;
    try {
      const texto = abrir(chaveDe(tenantId, process.env.JWT_SECRET, contexto), iv, tag, ct);
      console.warn(
        `[ia] blob cifrado com a chave LEGADA (JWT_SECRET) — tenant ${tenantId}/${contexto}. `
        + 'Re-salve essa credencial (ela é re-cifrada com IA_CRYPTO_KEY automaticamente no próximo salvamento).'
      );
      return texto;
    } catch {
      throw erroPrimario;
    }
  }
}

module.exports = { criptografar, descriptografar, chaveDe };
