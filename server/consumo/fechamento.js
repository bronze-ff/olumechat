// consumo/fechamento.js — fechamento mensal (FIL-77): agrega consumo_evento
// (bruto) em consumo_mensal (fechado, para sempre — é a fonte do faturamento
// do FIL-79) e aplica a retenção do bruto.
//
// CROSS-TENANT DE PROPÓSITO (mesmo padrão de bot/sweeper.js e
// campanha/dispatcher.js): roda em comOperador() (BYPASSRLS) porque agrega
// TODOS os tenants numa passada só; cada query nomeia tenant_id explicitamente
// (ver operador/db.js). Lock de liderança via advisory lock (workers/leaderLock)
// contra disparo duplicado com mais de uma instância do processo.
'use strict';

const { comOperador } = require('../operador/db');
const { tentarGlobal } = require('../workers/leaderLock');

const INTERVALO_MS = 24 * 60 * 60 * 1000; // 1x/dia
const DIAS_RETENCAO_PADRAO = Number(process.env.CONSUMO_RETENCAO_DIAS) || 90;
let timer = null;

function anoMesDe(data) { return data.toISOString().slice(0, 7); } // 'YYYY-MM' (UTC)

function mesAnteriorDe(data) {
  const d = new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth() - 1, 1));
  return anoMesDe(d);
}

/**
 * Agrega consumo_evento → consumo_mensal para UMA competência (`ano_mes`),
 * todos os tenants e tipos numa passada. IDEMPOTENTE: o UPSERT (chave
 * tenant_id+ano_mes+tipo) reescreve o mesmo agregado — rodar duas vezes não
 * duplica linha nem soma em dobro (critério de aceite do ticket).
 *
 * ⚠️ Achado de review (P1): `SUM(custo_centavos)` ignora linhas com custo
 * desconhecido (NULL — preço ainda não cadastrado, ver ia/client.js) em vez
 * de propagar a incerteza. Um `COALESCE(...,0)` transformaria "não sabemos"
 * em "grátis" — e como o bruto é apagado depois (limparEventosAntigos), essa
 * incerteza se perderia PARA SEMPRE. Por isso: se QUALQUER evento do grupo
 * tem custo desconhecido, o agregado inteiro fica NULL (custo indisponível/
 * parcial), nunca um número que pareça completo mas não é.
 * @param {object} conn conexão de operador (comOperador) já aberta
 * @param {string} anoMes 'YYYY-MM'
 * @returns {Promise<number>} quantas linhas (tenant_id+tipo) foram fechadas
 */
async function fecharMes(conn, anoMes) {
  const r = await conn.execute(
    `SELECT tenant_id, tipo,
            COALESCE(SUM(quantidade), 0) AS quantidade,
            CASE WHEN bool_or(custo_centavos IS NULL) THEN NULL ELSE SUM(custo_centavos) END AS custo_centavos
       FROM consumo_evento
      WHERE to_char(criado_em, 'YYYY-MM') = :anoMes
      GROUP BY tenant_id, tipo`,
    { anoMes }
  );
  for (const row of r.rows) {
    await conn.execute(
      `INSERT INTO consumo_mensal (tenant_id, ano_mes, tipo, quantidade, custo_centavos, fechado_em)
       VALUES (:tenantId, :anoMes, :tipo, :qtd, :custo, now())
       ON CONFLICT (tenant_id, ano_mes, tipo) DO UPDATE SET
         quantidade = EXCLUDED.quantidade, custo_centavos = EXCLUDED.custo_centavos, fechado_em = now()`,
      { tenantId: row.TENANT_ID, anoMes, tipo: row.TIPO, qtd: row.QUANTIDADE, custo: row.CUSTO_CENTAVOS }
    );
  }
  return r.rows.length;
}

/**
 * Apaga eventos brutos com mais de `diasRetencao` dias — SÓ os que já têm um
 * fechamento correspondente em consumo_mensal (mesmo tenant_id + a
 * competência do evento). Nunca perde dado que ainda não virou agregado,
 * mesmo que o tick de fechamento tenha falhado ou atrasado.
 * @returns {Promise<number>} linhas apagadas
 */
async function limparEventosAntigos(conn, diasRetencao = DIAS_RETENCAO_PADRAO) {
  const r = await conn.execute(
    `DELETE FROM consumo_evento e
      WHERE e.criado_em < now() - make_interval(days => :dias)
        AND EXISTS (
          SELECT 1 FROM consumo_mensal m
           WHERE m.tenant_id = e.tenant_id AND m.ano_mes = to_char(e.criado_em, 'YYYY-MM')
        )`,
    { dias: Math.max(0, Math.round(Number(diasRetencao) || 0)) }
  );
  return r.rowsAffected || 0;
}

/** Toda competência com pelo menos 1 evento bruto ainda presente — é o
 *  universo do que PRECISA de fechamento agora (naturalmente limitado a
 *  poucos meses: uma vez fechada e purgada pela retenção, a competência some
 *  desta lista sozinha). */
async function mesesComEventoBruto(conn) {
  const r = await conn.execute(
    `SELECT DISTINCT to_char(criado_em, 'YYYY-MM') AS ano_mes FROM consumo_evento ORDER BY 1`
  );
  return r.rows.map((row) => row.ANO_MES);
}

/**
 * Um tick: fecha TODA competência que ainda tem evento bruto pendente — não
 * só o mês corrente e o anterior.
 *
 * ⚠️ Achado de review (P2): fechar só "atual + anterior" deixa órfã qualquer
 * competência mais antiga se o processo ficou fora do ar por mais de uma
 * virada de mês — nenhum tick posterior voltaria a fechá-la, e a retenção
 * NUNCA apagaria aqueles eventos brutos (limparEventosAntigos só remove o que
 * já tem fechamento correspondente). Descobrir as competências a partir do
 * que EXISTE em consumo_evento (em vez de assumir "no máximo 1 mês atrás")
 * fecha qualquer lacuna de downtime sozinho, sem lista fixa.
 */
async function tick() {
  try {
    await comOperador(async (conn) => {
      if (!(await tentarGlobal(conn, 'consumo'))) return; // outra instância já está rodando o tick
      const meses = await mesesComEventoBruto(conn);
      const anoMesAtual = anoMesDe(new Date());
      if (!meses.includes(anoMesAtual)) meses.push(anoMesAtual); // fecha o mês corrente mesmo sem evento ainda
      for (const anoMes of meses) await fecharMes(conn, anoMes);
      await limparEventosAntigos(conn);
    });
  } catch (err) {
    console.error('[consumo] fechamento/retenção falhou:', err.message);
  }
}

function iniciar() {
  if (timer) return;
  tick().catch(() => {}); // primeiro fechamento já no boot — não espera 24h
  timer = setInterval(tick, INTERVALO_MS);
  if (timer.unref) timer.unref();
}

function parar() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  fecharMes, limparEventosAntigos, tick, iniciar, parar,
  anoMesDe, mesAnteriorDe, mesesComEventoBruto,
};
