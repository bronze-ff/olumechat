'use strict';

const db = require('../db/pool');
const { criptografar, descriptografar } = require('../ia/crypto');

const CONTEXTO = 'meta_access_token';

// FIL-97: o `waba_id` do UPSERT é COALESCE (não EXCLUDED puro). Salvar só o
// token permanente — caminho novo do app por cliente, onde o WABA ID pode não
// estar à mão — apagava silenciosamente o WABA já conectado por Embedded Signup.
async function guardar({ tenantId, accessToken, wabaId, status = 'conectada', conn }) {
  if (!Number.isSafeInteger(Number(tenantId)) || !accessToken) throw new Error('tenantId e accessToken são obrigatórios');
  const token = criptografar(String(accessToken), Number(tenantId), undefined, CONTEXTO);
  const executar = async (c) => c.execute(
    `INSERT INTO meta_conexao (tenant_id, waba_id, access_token_criptografado, status, atualizado_em)
     VALUES (:tenantId, :wabaId, :token, :status, now())
     ON CONFLICT (tenant_id) DO UPDATE SET waba_id = COALESCE(EXCLUDED.waba_id, meta_conexao.waba_id),
       access_token_criptografado = EXCLUDED.access_token_criptografado,
       status = EXCLUDED.status, ultimo_erro = NULL, atualizado_em = now()`,
    { tenantId: Number(tenantId), wabaId: wabaId || null, token, status });
  if (conn) return executar(conn);
  return db.comTenant(Number(tenantId), executar);
}

async function resolver(phoneNumberId, tenantId) {
  if (!phoneNumberId && !tenantId) return null;
  const conn = await db.getConnection();
  try {
    const r = await conn.execute(
      `SELECT m.tenant_id, n.phone_number_id, m.waba_id, m.access_token_criptografado
         FROM meta_conexao m
         LEFT JOIN numero n ON n.tenant_id = m.tenant_id
        WHERE ${phoneNumberId ? 'n.phone_number_id = :phone' : 'm.tenant_id = :tenantId'}
          ${phoneNumberId && tenantId ? 'AND n.tenant_id = :tenantId' : ''}
        ORDER BY n.id NULLS LAST
        FETCH FIRST 1 ROW ONLY`,
      phoneNumberId ? (tenantId ? { phone: phoneNumberId, tenantId } : { phone: phoneNumberId }) : { tenantId });
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
