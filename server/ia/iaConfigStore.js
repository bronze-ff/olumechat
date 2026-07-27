'use strict';
const { descriptografar } = require('./crypto');

const TTL_MS = 60_000;
let cache = null;
let exp = 0;

async function carregar(conn) {
  if (cache !== null && exp > Date.now()) return cache;
  try {
    const r = await conn.execute(
      `SELECT PROVIDER, MODELO, BASE_URL, API_KEY_CRIPTOGRAFADA
         FROM MC_ZAP_IA_CONFIG WHERE ID = 1 AND ATIVO = 'S'`
    );
    if (!r.rows || !r.rows.length) { cache = null; exp = Date.now() + TTL_MS; return null; }
    const row = r.rows[0];
    // Falha de decifragem (IA_CRYPTO_KEY/JWT_SECRET mudou, blob corrompido) NÃO
    // pode propagar — senão o runtime morre em silêncio. Tratamos como "config
    // indisponível" (null) e o runtime envia a mensagem de fallback ao usuário.
    let apiKey;
    try {
      apiKey = descriptografar(row.API_KEY_CRIPTOGRAFADA);
    } catch (e) {
      console.error('[ia] API key não decifrável — reconfigure o provedor no painel:', e.message);
      cache = null; exp = Date.now() + TTL_MS;
      return null;
    }
    cache = {
      provider: row.PROVIDER,
      modelo: row.MODELO,
      baseUrl: row.BASE_URL || null,
      apiKey,
    };
    exp = Date.now() + TTL_MS;
    return cache;
  } catch (err) {
    if (err.errorNum === 942) return null; // tabela ainda não criada
    throw err;
  }
}

function invalidar() { cache = null; exp = 0; }

module.exports = { carregar, invalidar };
