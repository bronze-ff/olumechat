// Blacklist compartilhada de jti revogados (FIL-74).
//
// O banco é a fonte de verdade. O Map abaixo só guarda revogações feitas pela
// instância corrente para que o logout tenha efeito imediato; ele é positivo,
// não negativo, e expira junto com o JWT. Assim, outra instância sempre
// consulta a tabela e enxerga o logout imediatamente (sem janela de cache).
'use strict';

const db = require('../db/pool');
const operadorDb = require('../operador/db');

const local = new Map(); // jti -> expiração em milissegundos
const LIMPEZA_MS = 15 * 60 * 1000;

function expiraEm(exp) {
  const ms = Number(exp) * 1000;
  if (!Number.isFinite(ms) || ms <= Date.now()) return new Date(Date.now() + 1);
  return new Date(ms);
}

function cacheValido(jti) {
  const exp = local.get(jti);
  if (!exp) return false;
  if (exp <= Date.now()) { local.delete(jti); return false; }
  return true;
}

async function emContexto(contexto, fn) {
  if (contexto && contexto.tenantId != null) {
    return db.comTenant(contexto.tenantId, fn);
  }
  return operadorDb.comOperador(fn);
}

/** Revoga o jti e persiste a expiração original do JWT. */
function add(jti, exp, contexto = {}) {
  if (!jti) return Promise.resolve();
  const expira = expiraEm(exp);
  local.set(String(jti), expira.getTime());
  // Sem DATABASE_URL há apenas testes unitários; em produção o boot já exige
  // DATABASE_URL. O cache permite que esses testes exercitem o middleware.
  if (!process.env.DATABASE_URL) return Promise.resolve();
  return emContexto(contexto, async (conn) => {
    await conn.execute(
      `INSERT INTO token_blacklist (jti, tenant_id, expira_em)
       VALUES (:jti, :tenantId, :expiraEm)
       ON CONFLICT (jti) DO UPDATE SET expira_em = EXCLUDED.expira_em`,
      { jti: String(jti), tenantId: contexto.tenantId ?? null, expiraEm: expira }
    );
  });
}

/** Consulta a fonte compartilhada; a limpeza oportunista impede crescimento. */
async function has(jti, contexto = {}) {
  if (!jti || cacheValido(String(jti))) return cacheValido(String(jti));
  if (!process.env.DATABASE_URL) return false;
  return emContexto(contexto, async (conn) => {
    await conn.execute('DELETE FROM token_blacklist WHERE expira_em <= now()');
    const r = await conn.execute(
      'SELECT 1 FROM token_blacklist WHERE jti = :jti AND expira_em > now()',
      { jti: String(jti) }
    );
    return r.rows.length > 0;
  });
}

async function limparExpirados() {
  if (!process.env.DATABASE_URL) return 0;
  return operadorDb.comOperador(async (conn) => {
    const r = await conn.execute('DELETE FROM token_blacklist WHERE expira_em <= now()');
    return r.rowsAffected || 0;
  });
}

const timer = setInterval(() => {
  for (const [jti, exp] of local) if (exp <= Date.now()) local.delete(jti);
  limparExpirados().catch(() => {});
}, LIMPEZA_MS);
timer.unref?.();

module.exports = { add, has, limparExpirados, _local: local };
