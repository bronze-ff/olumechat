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
const { validarDataYYYYMMDD } = require('../utils/data');

function validarData(v, nomeCampo, padrao) {
  if (v === undefined || v === null || v === '') return padrao;
  return validarDataYYYYMMDD(v, nomeCampo, ErroOperador);
}

/**
 * Série de consumo por tipo (quantidade + custo) de um tenant, no período
 * [de, ate] (inclusive). Sem `de`/`ate`, usa o mês corrente.
 *
 * Achado de review (FIL-76): o bruto (`consumo_evento`) só guarda ~90 dias
 * (retenção, ver consumo/fechamento.js) — um range que cai fora dessa janela
 * voltava vazio ou parcial mesmo com o total permanente já fechado em
 * `consumo_mensal`. Regra por (mês, tipo) dentro do intervalo pedido: se o
 * BRUTO tem alguma linha, confia nele (precisão de dia); só cai pro AGREGADO
 * MENSAL retido quando o bruto daquele mês já foi limpo pela retenção —
 * nunca soma os dois juntos (dobraria a contagem). `retidoParcial` avisa o
 * operador quando algum mês do range veio do agregado (sem precisão de dia).
 */
async function consumoDoTenant({ tenantId, de, ate }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const inicioMes = `${new Date().toISOString().slice(0, 7)}-01`;
  const deNorm = validarData(de, 'Data inicial (de)', inicioMes);
  const ateNorm = validarData(ate, 'Data final (ate)', hoje);
  if (deNorm > ateNorm) throw new ErroOperador(400, 'Data inicial (de) não pode ser depois da data final (ate).');

  return comOperador(async (conn) => {
    const t = await conn.execute(`SELECT id FROM tenant WHERE id = :id`, { id: tenantId });
    if (!t.rows.length) throw new ErroOperador(404, 'Tenant não encontrado.');

    const bruto = await conn.execute(
      `SELECT to_char(criado_em, 'YYYY-MM') AS ano_mes, tipo,
              COALESCE(SUM(quantidade), 0)     AS quantidade,
              COALESCE(SUM(custo_centavos), 0) AS custo_centavos,
              bool_or(custo_centavos IS NULL)  AS custo_incompleto,
              COUNT(*)                          AS eventos
         FROM consumo_evento
        WHERE tenant_id = :tenantId
          AND criado_em >= :de::date AND criado_em < (:ate::date + 1)
        GROUP BY ano_mes, tipo`,
      { tenantId, de: deNorm, ate: ateNorm }
    );
    const mesesCobertosPeloBruto = new Set(bruto.rows.map((row) => row.ANO_MES));

    const retido = await conn.execute(
      `SELECT ano_mes, tipo, quantidade, custo_centavos, custo_incompleto
         FROM consumo_mensal
        WHERE tenant_id = :tenantId
          AND ano_mes BETWEEN to_char(:de::date, 'YYYY-MM') AND to_char(:ate::date, 'YYYY-MM')`,
      { tenantId, de: deNorm, ate: ateNorm }
    );

    const porTipo = new Map(); // tipo -> { quantidade, custoCentavos, eventos, custoIncompleto }
    const somar = (tipo, quantidade, custoCentavos, custoIncompleto, eventos = 0) => {
      const atual = porTipo.get(tipo) || { quantidade: 0, custoCentavos: 0, eventos: 0, custoIncompleto: false };
      atual.quantidade += quantidade;
      atual.custoCentavos += custoCentavos;
      atual.eventos += eventos;
      atual.custoIncompleto = atual.custoIncompleto || custoIncompleto;
      porTipo.set(tipo, atual);
    };
    for (const row of bruto.rows) {
      somar(row.TIPO, Number(row.QUANTIDADE), Number(row.CUSTO_CENTAVOS), row.CUSTO_INCOMPLETO === true, Number(row.EVENTOS));
    }
    let retidoParcial = false;
    for (const row of retido.rows) {
      if (mesesCobertosPeloBruto.has(row.ANO_MES)) continue; // o bruto já cobre esse mês — nunca soma os dois
      retidoParcial = true;
      somar(row.TIPO, Number(row.QUANTIDADE), Number(row.CUSTO_CENTAVOS), row.CUSTO_INCOMPLETO === true);
    }

    const serie = [...porTipo.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tipo, v]) => ({
        tipo, quantidade: v.quantidade, custoCentavos: v.custoCentavos,
        eventos: v.eventos, custoIncompleto: v.custoIncompleto,
      }));

    return { tenantId, de: deNorm, ate: ateNorm, serie, retidoParcial };
  });
}

module.exports = { consumoDoTenant };
