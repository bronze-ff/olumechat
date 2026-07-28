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

function validarData(v, nomeCampo, padrao) {
  if (v === undefined || v === null || v === '') return padrao;
  if (!RE_DATA.test(String(v))) throw new ErroOperador(400, `${nomeCampo} inválida — use AAAA-MM-DD.`);
  return String(v);
}

/** Série de consumo por tipo (quantidade + custo) de um tenant, no período
 *  [de, ate] (inclusive). Sem `de`/`ate`, usa o mês corrente. */
async function consumoDoTenant({ tenantId, de, ate }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const inicioMes = `${new Date().toISOString().slice(0, 7)}-01`;
  const deNorm = validarData(de, 'Data inicial (de)', inicioMes);
  const ateNorm = validarData(ate, 'Data final (ate)', hoje);
  if (deNorm > ateNorm) throw new ErroOperador(400, 'Data inicial (de) não pode ser depois da data final (ate).');

  return comOperador(async (conn) => {
    const t = await conn.execute(`SELECT id FROM tenant WHERE id = :id`, { id: tenantId });
    if (!t.rows.length) throw new ErroOperador(404, 'Tenant não encontrado.');

    const r = await conn.execute(
      `SELECT tipo,
              COALESCE(SUM(quantidade), 0)     AS quantidade,
              COALESCE(SUM(custo_centavos), 0) AS custo_centavos,
              COUNT(*)                          AS eventos
         FROM consumo_evento
        WHERE tenant_id = :tenantId
          AND criado_em >= :de::date AND criado_em < (:ate::date + 1)
        GROUP BY tipo
        ORDER BY tipo`,
      { tenantId, de: deNorm, ate: ateNorm }
    );
    return {
      tenantId, de: deNorm, ate: ateNorm,
      serie: r.rows.map((row) => ({
        tipo: row.TIPO,
        quantidade: Number(row.QUANTIDADE),
        custoCentavos: Number(row.CUSTO_CENTAVOS),
        eventos: Number(row.EVENTOS),
      })),
    };
  });
}

module.exports = { consumoDoTenant };
