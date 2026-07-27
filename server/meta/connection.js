'use strict';

const db = require('../db/pool');
const { criptografar, descriptografar } = require('../ia/crypto');

const CONTEXTO = 'meta_access_token';

async function guardar({ tenantId, accessToken, wabaId, status = 'conectada', conn }) {
  if (!Number.isSafeInteger(Number(tenantId)) || !accessToken) throw new Error('tenantId e accessToken são obrigatórios');
  const token = criptografar(String(accessToken), Number(tenantId), undefined, CONTEXTO);
  const executar = async (c) => c.execute(
    `INSERT INTO meta_conexao (tenant_id, waba_id, access_token_criptografado, status, atualizado_em)
     VALUES (:tenantId, :wabaId, :token, :status, now())
     ON CONFLICT (tenant_id) DO UPDATE SET waba_id = EXCLUDED.waba_id,
       access_token_criptografado = EXCLUDED.access_token_criptografado,
       status = EXCLUDED.status, ultimo_erro = NULL, atualizado_em = now()`,
    { tenantId: Number(tenantId), wabaId: wabaId || null, token, status });
  if (conn) return executar(conn);
  return db.comTenant(Number(tenantId), executar);
}

async function resolver(phoneNumberId, tenantId) {
  if (!phoneNumberId) return null;
  const conn = await db.getConnection();
  try {
    const r = await conn.execute(
      `SELECT n.tenant_id, n.phone_number_id, m.waba_id, m.access_token_criptografado
         FROM numero n JOIN meta_conexao m ON m.tenant_id = n.tenant_id
        WHERE n.phone_number_id = :phone${tenantId ? ' AND n.tenant_id = :tenantId' : ''}`,
      tenantId ? { phone: phoneNumberId, tenantId } : { phone: phoneNumberId });
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      tenantId: row.TENANT_ID,
      phoneNumberId: row.PHONE_NUMBER_ID,
      wabaId: row.WABA_ID || null,
      accessToken: descriptografar(row.ACCESS_TOKEN_CRIPTOGRAFADO, row.TENANT_ID, undefined, CONTEXTO),
    };
  } finally { await conn.close().catch(() => {}); }
}

module.exports = { guardar, resolver, CONTEXTO };
