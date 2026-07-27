// operador/db.js — O CAMINHO DE BANCO DO OPERADOR (FIL-70).
//
// Este é o único lugar do sistema que abre transação SEM contexto de tenant de
// propósito. Ele existe justamente para ser óbvio: se uma query atravessa
// tenants, ela passa por aqui e o nome da função diz isso. É o mesmo padrão de
// "system path" já documentado em campanha/dispatcher.js (o tick que varre
// campanhas de todos os tenants) e em fila/distribuidor.js.
//
// ── COMO DIFERE DE comTenant() ──────────────────────────────────────────────
//   comTenant(id, fn)  → SET LOCAL ROLE falatta_app + set_config(tenant, id)
//                        ⇒ a RLS isola: só as linhas daquele tenant.
//   comOperador(fn)    → contexto de tenant explicitamente NULO, sem troca de
//                        papel ⇒ roda com o usuário do DATABASE_URL (dono do
//                        banco no Neon, BYPASSRLS). Enxerga todos os tenants.
//
// ⚠️ POR ISSO, DENTRO DE comOperador() NÃO EXISTE REDE DE SEGURANÇA. A RLS não
// vai te salvar de esquecer um `WHERE tenant_id = :id`. Regra deste módulo:
// TODA query que toca tabela de tenant nomeia `tenant_id` explicitamente, e as
// que são cross-tenant de propósito (listagem, agregados) dizem isso no
// comentário. Nada de "às vezes tem tenant, às vezes não" no mesmo código.
//
// ── ENTRAR NUM TENANT DENTRO DA MESMA TRANSAÇÃO ─────────────────────────────
// O provisionamento precisa criar o `tenant` (contexto NULO — é a policy
// `tenant_operador` da 001 que autoriza) e, na MESMA transação, gravar em
// `usuario`/`atendente`/`usuario_token_senha` (que têm DEFAULT tenant_atual()
// e policy `isolamento_tenant`). `entrarNoTenant()` troca o contexto no meio
// da transação; `sairDoTenant()` volta para NULO. Ambos usam
// set_config(..., true) — transaction-scoped, compatível com o pooler. NUNCA
// SET SESSION (ver docs/PORTE.md §1.2).
//
// Atomicidade: uma transação só. Falhou no meio ⇒ ROLLBACK ⇒ nem tenant, nem
// usuário, nem convite. É o critério de aceite "falha no meio não deixa tenant
// órfão".
'use strict';

const db = require('../db/pool');

const SQL_SET_TENANT = `SELECT set_config('app.current_tenant_id', :tid, true)`;
/** '' vira NULL em tenant_atual() (NULLIF(...,'')) — contexto de operador. */
const SQL_SEM_TENANT = `SELECT set_config('app.current_tenant_id', '', true)`;

/** Aceita só inteiro positivo (o id vem de `bigint GENERATED ... IDENTITY`). */
function idValido(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Entra no contexto de um tenant DENTRO de uma transação de operador já
 * aberta. Não troca de papel: o objetivo é fazer as policies/DEFAULTs de
 * `tenant_atual()` funcionarem, não abrir mão do alcance do operador.
 * @param {object} conn conexão da transação em andamento
 * @param {number} tenantId
 */
async function entrarNoTenant(conn, tenantId) {
  const id = idValido(tenantId);
  if (!id) throw new Error(`entrarNoTenant: tenantId inválido: ${JSON.stringify(tenantId)}`);
  await conn.execute(SQL_SET_TENANT, { tid: String(id) });
  return id;
}

/** Volta ao contexto de operador (tenant NULO) na mesma transação. */
async function sairDoTenant(conn) {
  await conn.execute(SQL_SEM_TENANT);
}

/**
 * Roda `fn(conn)` numa transação de operador: contexto de tenant NULO, sem
 * troca de papel. Commit no sucesso, rollback no erro, conexão sempre
 * devolvida ao pool.
 * @param {(conn: object) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function comOperador(fn) {
  // db.getConnection é lido do módulo a cada chamada — é assim que os testes
  // trocam o banco por um duble (mesmo padrão do resto da suíte).
  const conn = await db.getConnection();
  try {
    // Explícito, mesmo sendo o estado natural de uma transação nova: deixa a
    // intenção no código (e no log de SQL dos testes), em vez de depender de
    // "não setamos, então deve estar nulo".
    await conn.execute(SQL_SEM_TENANT);
    const resultado = await fn(conn);
    await conn.commit();
    return resultado;
  } catch (err) {
    try { await conn.rollback(); } catch { /* prioriza o erro original */ }
    throw err;
  } finally {
    await conn.close();
  }
}

module.exports = { comOperador, entrarNoTenant, sairDoTenant, idValido };
