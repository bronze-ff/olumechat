// operador/consumo.js — série de consumo por tenant (FIL-77), para o
// operador ver quanto um cliente consumiu, quanto custou pra nós e decidir
// quanto cobrar. Nenhum destes campos (custo/tokens/preço) existe em rota de
// tenant — ver docs/SEGURANCA.md.
//
// CROSS-TENANT DE PROPÓSITO (comOperador): a query nomeia tenant_id
// explicitamente — não depende da RLS para separar um cliente do outro (ver
// operador/db.js).
'use strict';

const { comOperador } = require('./db');
const { ErroOperador } = require('./erroOperador');

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Regex + round-trip por Date: barra data de calendário IMPOSSÍVEL
 * (2026-02-31, 2026-99-99) ANTES do `::date` do Postgres.
 *
 * Achado de review (P2): sem o round-trip, essas passavam pelo regex, batiam
 * no cast do banco e voltavam como 500 genérico em vez do 400 de validação
 * documentado da rota.
 */
function validarData(v, nomeCampo, padrao) {
  if (v === undefined || v === null || v === '') return padrao;
  const s = String(v);
  if (!RE_DATA.test(s)) throw new ErroOperador(400, `${nomeCampo} inválida — use AAAA-MM-DD.`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new ErroOperador(400, `${nomeCampo} inválida — data de calendário inexistente.`);
  }
  return s;
}

/**
 * Soma dois custos "com incerteza": se qualquer um dos lados for `null`
 * (custo desconhecido — preço não cadastrado para algum evento daquele
 * grupo), o combinado é `null` — nunca um número que pareça completo sem
 * ser (mesmo racional de consumo/fechamento.js::fecharMes).
 */
function somarCusto(a, b) {
  if (a === null || b === null) return null;
  return (a || 0) + (b || 0);
}

function numOuNull(v) {
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Série de consumo por tipo (quantidade + custo) de um tenant, no período
 * [de, ate] (inclusive). Sem `de`/`ate`, usa o mês corrente.
 *
 * ⚠️ Achado de review (P2): meses fora do corrente vêm de `consumo_mensal`
 * (agregado permanente, fechado por server/consumo/fechamento.js) — nunca só
 * de `consumo_evento`, que a retenção já pode ter apagado (90 dias por
 * padrão). Só o mês CORRENTE (que o tick de fechamento ainda pode não ter
 * fechado hoje) usa o bruto, mais atualizado. As duas fontes NUNCA se
 * sobrepõem no mesmo mês — sem risco de contar o mesmo evento duas vezes.
 * Limitação assumida: para um período histórico que começa/termina NO MEIO
 * de um mês já fora do corrente, a granularidade vira o mês inteiro (o bruto
 * daquele mês pode já ter sido purgado — não há como fatiar um agregado
 * mensal por dia). Faixas de mês cheio são exatas.
 */
async function consumoDoTenant({ tenantId, de, ate }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const inicioMes = `${new Date().toISOString().slice(0, 7)}-01`;
  const deNorm = validarData(de, 'Data inicial (de)', inicioMes);
  const ateNorm = validarData(ate, 'Data final (ate)', hoje);
  if (deNorm > ateNorm) throw new ErroOperador(400, 'Data inicial (de) não pode ser depois da data final (ate).');

  const anoMesAtual = new Date().toISOString().slice(0, 7);
  const inicioMesAtual = `${anoMesAtual}-01`;
  const anoMesDeReq = deNorm.slice(0, 7);
  const anoMesAteReq = ateNorm.slice(0, 7);

  return comOperador(async (conn) => {
    const t = await conn.execute(`SELECT id FROM tenant WHERE id = :id`, { id: tenantId });
    if (!t.rows.length) throw new ErroOperador(404, 'Tenant não encontrado.');

    // Meses PASSADOS (já fora do corrente) dentro do intervalo: sempre do
    // agregado permanente — nunca do bruto, que pode já ter sido purgado.
    const mensal = await conn.execute(
      `SELECT tipo,
              COALESCE(SUM(quantidade), 0) AS quantidade,
              CASE WHEN bool_or(custo_centavos IS NULL) THEN NULL ELSE SUM(custo_centavos) END AS custo_centavos
         FROM consumo_mensal
        WHERE tenant_id = :tenantId
          AND ano_mes >= :anoMesDe AND ano_mes <= :anoMesAte AND ano_mes < :anoMesAtual
        GROUP BY tipo`,
      { tenantId, anoMesDe: anoMesDeReq, anoMesAte: anoMesAteReq, anoMesAtual }
    );

    // Parte do intervalo que cai no mês CORRENTE: do bruto (o painel não
    // pode esperar o próximo tick diário de fechamento para refletir hoje).
    const deBruto = deNorm > inicioMesAtual ? deNorm : inicioMesAtual;
    const bruto = await conn.execute(
      `SELECT tipo,
              COALESCE(SUM(quantidade), 0) AS quantidade,
              CASE WHEN bool_or(custo_centavos IS NULL) THEN NULL ELSE SUM(custo_centavos) END AS custo_centavos,
              COUNT(*) AS eventos
         FROM consumo_evento
        WHERE tenant_id = :tenantId
          AND criado_em >= :deBruto::date AND criado_em < (:ate::date + 1)
        GROUP BY tipo`,
      { tenantId, deBruto, ate: ateNorm }
    );

    const porTipo = new Map();
    for (const row of mensal.rows) {
      porTipo.set(row.TIPO, {
        tipo: row.TIPO, quantidade: Number(row.QUANTIDADE),
        custoCentavos: numOuNull(row.CUSTO_CENTAVOS), eventos: 0,
      });
    }
    for (const row of bruto.rows) {
      const atual = porTipo.get(row.TIPO) || { tipo: row.TIPO, quantidade: 0, custoCentavos: 0, eventos: 0 };
      atual.quantidade += Number(row.QUANTIDADE);
      atual.custoCentavos = somarCusto(atual.custoCentavos, numOuNull(row.CUSTO_CENTAVOS));
      atual.eventos += Number(row.EVENTOS);
      porTipo.set(row.TIPO, atual);
    }

    return {
      tenantId, de: deNorm, ate: ateNorm,
      serie: [...porTipo.values()].sort((a, b) => a.tipo.localeCompare(b.tipo)),
    };
  });
}

module.exports = { consumoDoTenant };
