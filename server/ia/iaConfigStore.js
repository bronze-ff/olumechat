// server/ia/iaConfigStore.js — cache da config ativa do provedor de IA
// (ia_config), 1 linha por tenant. FIL-63: a config é por tenant, então o
// cache TEM que ser chaveado por tenant — um cache global (como no fork)
// vazaria a config (e a apiKey decifrada) de um tenant pro outro.
'use strict';
const { descriptografar } = require('./crypto');

const TTL_MS = 60_000;
const cache = new Map(); // tenantId (string) -> { valor, exp }

async function carregar(conn, tenantId) {
  const chave = String(tenantId);
  const hit = cache.get(chave);
  if (hit && hit.exp > Date.now()) return hit.valor;
  try {
    const r = await conn.execute(
      `SELECT PROVIDER, MODELO, BASE_URL, API_KEY_CRIPTOGRAFADA
         FROM ia_config WHERE tenant_id = :tenantId AND ID = 1 AND ATIVO = 'S'`,
      { tenantId }
    );
    if (!r.rows || !r.rows.length) {
      cache.set(chave, { valor: null, exp: Date.now() + TTL_MS });
      return null;
    }
    const row = r.rows[0];
    // Falha de decifragem (IA_CRYPTO_KEY/JWT_SECRET mudou, blob corrompido) NÃO
    // pode propagar — senão o runtime morre em silêncio. Tratamos como "config
    // indisponível" (null) e o runtime envia a mensagem de fallback ao usuário.
    let apiKey;
    try {
      apiKey = descriptografar(row.API_KEY_CRIPTOGRAFADA, tenantId);
    } catch (e) {
      console.error('[ia] API key não decifrável — reconfigure o provedor no painel:', e.message);
      cache.set(chave, { valor: null, exp: Date.now() + TTL_MS });
      return null;
    }
    const valor = {
      provider: row.PROVIDER,
      modelo: row.MODELO,
      baseUrl: row.BASE_URL || null,
      apiKey,
    };
    cache.set(chave, { valor, exp: Date.now() + TTL_MS });
    return valor;
  } catch (err) {
    if (err.code === '42P01') return null; // tabela ainda não criada (undefined_table)
    throw err;
  }
}

/** Invalida o cache de um tenant (ou de todos, se tenantId omitido). */
function invalidar(tenantId) {
  if (tenantId === undefined) cache.clear();
  else cache.delete(String(tenantId));
}

module.exports = { carregar, invalidar };
