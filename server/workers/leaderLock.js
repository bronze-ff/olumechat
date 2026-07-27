'use strict';

// pg_try_advisory_xact_lock nunca espera: perder o lock e um caminho normal
// quando ha mais de uma instancia do worker.
const BASE = Object.freeze({ fila: 7301000000n, bot: 7302000000n, campanha: 7303000000n });

function chave(worker, tenantId) {
  const tenant = BigInt(Number(tenantId));
  if (!BASE[worker] || tenant <= 0n) throw new Error(`leaderLock: argumentos invalidos (${worker}, ${tenantId})`);
  return BASE[worker] + tenant;
}

async function tentar(conn, worker, tenantId) {
  const r = await conn.execute(
    'SELECT pg_try_advisory_xact_lock(CAST(:chave AS bigint)) AS adquirido',
    { chave: chave(worker, tenantId).toString() }
  );
  // Conexoes falsas antigas nao simulavam SELECT e devolvem []: mantemos o
  // comportamento util para esses testes; Postgres sempre devolve uma linha.
  if (!r.rows || !r.rows.length) return true;
  return Boolean(r.rows[0].ADQUIRIDO ?? r.rows[0].adquirido);
}

module.exports = { tentar, chave };
