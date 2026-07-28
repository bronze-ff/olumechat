// server/ia/limitePlano.js — teto mensal do add-on de IA por tenant (FIL-78).
//
// Schema (migração 015): tenant.ia_teto_tokens_mes (NULL = sem teto) +
// ia_consumo_mensal (tenant_id, ano_mes, tokens_usados). O INCREMENTO do
// consumo real (tokens gastos a cada chamada) é o FIL-77 (medição) — esta
// função só LÊ o que já foi registrado e decide se bloqueia. Sem o FIL-77
// rodando, ia_consumo_mensal fica vazia e estourouTeto() nunca bloqueia
// sozinha: é o ponto de extensão que o ticket pediu, sem medição nenhuma
// implementada aqui.
'use strict';

const anoMesAtual = () => new Date().toISOString().slice(0, 7); // 'YYYY-MM' (UTC)

/** true se o tenant já bateu o teto mensal configurado pelo operador. */
async function estourouTeto(conn, tenantId) {
  const t = await conn.execute(`SELECT ia_teto_tokens_mes FROM tenant WHERE id = :tenantId`, { tenantId });
  const teto = (t.rows[0] || {}).IA_TETO_TOKENS_MES;
  if (teto === null || teto === undefined) return false; // sem teto configurado

  const r = await conn.execute(
    `SELECT tokens_usados FROM ia_consumo_mensal WHERE tenant_id = :tenantId AND ano_mes = :anoMes`,
    { tenantId, anoMes: anoMesAtual() }
  );
  const usados = r.rows.length ? Number(r.rows[0].TOKENS_USADOS) : 0;
  return usados >= Number(teto);
}

module.exports = { estourouTeto, anoMesAtual };
