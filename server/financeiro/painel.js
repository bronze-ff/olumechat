// financeiro/painel.js — painel financeiro do operador (FIL-80): MRR, a
// receber, atrasados e margem por cliente. Camada de LEITURA em cima do que
// FIL-76/77/78/79 já gravam — não reimplementa geração de fatura, cálculo de
// consumo nem credencial de IA (ver operador/contrato.js, operador/fatura.js,
// operador/consumo.js, operador/tenants.js, financeiro/faturamento.js).
//
// CROSS-TENANT DE PROPÓSITO (comOperador): mesmo racional do resto de
// operador/* — dentro de comOperador() não existe RLS, então toda query
// nomeia tenant_id explicitamente. SÓ o operador chama isto (ver
// docs/SEGURANCA.md): nenhuma rota de tenant expõe estas funções.
//
// ── CUSTO DESCONHECIDO NUNCA VIRA ZERO (ponto de atenção do ticket) ─────────
// Quando consumo_evento.custo_centavos é NULL para algum evento do período
// (preço ainda não cadastrado em preco_provedor — ver consumo/precos.js), a
// margem daquele cliente não é um número: é `null` + `custoDesconhecido:
// true`. O agregado da visão geral soma só os clientes com custo
// integralmente conhecido e sinaliza `margemParcial` quando algum ficou de
// fora — nunca finge que o custo desconhecido é zero.
'use strict';

const { comOperador } = require('../operador/db');
const tenants = require('../operador/tenants');
const fatura = require('../operador/fatura');
const faturamento = require('./faturamento');

/** cobrado - custo, ou null se o custo do período não é totalmente conhecido
 *  ou não há valor cobrado ainda (sem contrato/fatura). Nunca inventa zero. */
function calcularMargemCentavos({ cobradoCentavos, custoCentavos, custoDesconhecido }) {
  if (custoDesconhecido) return null;
  if (cobradoCentavos === null || cobradoCentavos === undefined) return null;
  return cobradoCentavos - Number(custoCentavos || 0);
}

function linhaClienteFinanceiro(row) {
  const cobradoCentavos = row.FATURA_VALOR_CENTAVOS !== null && row.FATURA_VALOR_CENTAVOS !== undefined
    ? Number(row.FATURA_VALOR_CENTAVOS)
    : (row.VALOR_RECORRENTE_CENTAVOS !== null && row.VALOR_RECORRENTE_CENTAVOS !== undefined
      ? Number(row.VALOR_RECORRENTE_CENTAVOS)
      : null);
  const custoCentavos = Number(row.CUSTO_CENTAVOS || 0);
  const custoDesconhecido = Number(row.CUSTO_DESCONHECIDO_CNT || 0) > 0;
  return {
    tenantId: Number(row.TENANT_ID),
    tenantNome: row.TENANT_NOME,
    tenantSlug: row.TENANT_SLUG,
    tenantStatus: row.TENANT_STATUS,
    planoNome: row.PLANO_NOME || null,
    faturaId: row.FATURA_ID !== null && row.FATURA_ID !== undefined ? Number(row.FATURA_ID) : null,
    faturaStatus: row.FATURA_STATUS || null,
    cobradoCentavos,
    custoCentavos,
    custoDesconhecido,
    margemCentavos: calcularMargemCentavos({ cobradoCentavos, custoCentavos, custoDesconhecido }),
  };
}

/**
 * Cobrado x custo x margem por cliente, na competência informada (padrão: mês
 * corrente). `cobrado` é a fatura da competência quando já gerada, senão o
 * valor recorrente do contrato ativo (estimativa — a fatura definitiva pode
 * ter excedente/desconto que só existem depois de gerada).
 */
async function listarClientesFinanceiro({ competencia } = {}) {
  const comp = competencia || faturamento.anoMesAtual();
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `SELECT t.id AS tenant_id, t.nome AS tenant_nome, t.slug AS tenant_slug, t.status AS tenant_status,
              c.plano_nome, c.valor_recorrente_centavos,
              f.id AS fatura_id, f.status AS fatura_status, f.valor_total_centavos AS fatura_valor_centavos,
              ce.custo_centavos, ce.custo_desconhecido_cnt
         FROM tenant t
         LEFT JOIN contrato c ON c.tenant_id = t.id AND c.fim_vigencia IS NULL
         LEFT JOIN fatura f ON f.tenant_id = t.id AND f.competencia = :competencia
         LEFT JOIN (
           SELECT tenant_id,
                  SUM(custo_centavos) FILTER (WHERE custo_centavos IS NOT NULL) AS custo_centavos,
                  COUNT(*) FILTER (WHERE custo_centavos IS NULL) AS custo_desconhecido_cnt
             FROM consumo_evento
            WHERE to_char(criado_em, 'YYYY-MM') = :competencia
            GROUP BY tenant_id
         ) ce ON ce.tenant_id = t.id
        WHERE t.status IN ('ativo', 'suspenso')
        ORDER BY t.nome`,
      { competencia: comp }
    );
    return r.rows.map(linhaClienteFinanceiro);
  });
}

async function mrrCentavos(conn) {
  const recorrencia = await conn.execute(
    `SELECT COALESCE(SUM(c.valor_recorrente_centavos), 0) AS total
       FROM contrato c
       JOIN tenant t ON t.id = c.tenant_id
      WHERE c.fim_vigencia IS NULL AND t.status = 'ativo'`
  );
  const itens = await conn.execute(
    `SELECT COALESCE(SUM(ci.valor_unitario_centavos * ci.quantidade), 0) AS total
       FROM contrato_item ci
       JOIN contrato c ON c.id = ci.contrato_id
       JOIN tenant t ON t.id = c.tenant_id
      WHERE c.fim_vigencia IS NULL AND t.status = 'ativo' AND ci.recorrente = true`
  );
  return Number((recorrencia.rows[0] || {}).TOTAL || 0) + Number((itens.rows[0] || {}).TOTAL || 0);
}

async function aReceberEAtrasado(conn, competencia) {
  const r = await conn.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN f.status <> 'cancelada'
                          THEN f.valor_total_centavos - COALESCE(pg.pago, 0) ELSE 0 END), 0) AS a_receber,
       COALESCE(SUM(CASE WHEN f.status = 'atrasada'
                          THEN f.valor_total_centavos - COALESCE(pg.pago, 0) ELSE 0 END), 0) AS atrasado,
       COUNT(*) FILTER (WHERE f.status = 'atrasada') AS atrasadas_count
       FROM fatura f
       LEFT JOIN (SELECT fatura_id, SUM(valor_centavos) AS pago FROM pagamento GROUP BY fatura_id) pg
              ON pg.fatura_id = f.id
      WHERE f.competencia = :competencia`,
    { competencia }
  );
  const row = r.rows[0] || {};
  return {
    aReceberCentavos: Number(row.A_RECEBER || 0),
    atrasadoCentavos: Number(row.ATRASADO || 0),
    faturasAtrasadas: Number(row.ATRASADAS_COUNT || 0),
  };
}

async function contagemClientes(conn) {
  const status = await conn.execute(`SELECT status, COUNT(*) AS cnt FROM tenant GROUP BY status`);
  const porStatus = { ativo: 0, suspenso: 0, encerrado: 0 };
  for (const row of status.rows) {
    if (Object.prototype.hasOwnProperty.call(porStatus, row.STATUS)) porStatus[row.STATUS] = Number(row.CNT);
  }
  const implantacao = await conn.execute(
    `SELECT COUNT(*) AS cnt FROM (
       SELECT DISTINCT ON (i.tenant_id) i.tenant_id, i.status
         FROM implementacao i
         JOIN tenant t ON t.id = i.tenant_id
        WHERE t.status = 'ativo'
        ORDER BY i.tenant_id, i.criado_em DESC, i.id DESC
     ) latest
      WHERE latest.status <> 'entregue'`
  );
  return {
    clientesAtivos: porStatus.ativo,
    clientesSuspensos: porStatus.suspenso,
    clientesImplantacao: Number((implantacao.rows[0] || {}).CNT || 0),
  };
}

/** Visão geral (home do financeiro): MRR, a receber, atrasado, clientes por
 *  status e margem estimada (nunca finge custo desconhecido como zero). */
async function resumoGeral() {
  const competencia = faturamento.anoMesAtual();
  return comOperador(async (conn) => {
    const [mrr, aReceber, clientes] = await Promise.all([
      mrrCentavos(conn),
      aReceberEAtrasado(conn, competencia),
      contagemClientes(conn),
    ]);
    const r = await conn.execute(
      `SELECT t.id AS tenant_id, t.status AS tenant_status,
              c.valor_recorrente_centavos,
              f.valor_total_centavos AS fatura_valor_centavos,
              ce.custo_centavos, ce.custo_desconhecido_cnt
         FROM tenant t
         LEFT JOIN contrato c ON c.tenant_id = t.id AND c.fim_vigencia IS NULL
         LEFT JOIN fatura f ON f.tenant_id = t.id AND f.competencia = :competencia
         LEFT JOIN (
           SELECT tenant_id,
                  SUM(custo_centavos) FILTER (WHERE custo_centavos IS NOT NULL) AS custo_centavos,
                  COUNT(*) FILTER (WHERE custo_centavos IS NULL) AS custo_desconhecido_cnt
             FROM consumo_evento
            WHERE to_char(criado_em, 'YYYY-MM') = :competencia
            GROUP BY tenant_id
         ) ce ON ce.tenant_id = t.id
        WHERE t.status = 'ativo'`,
      { competencia }
    );
    let margemCentavos = 0;
    let margemParcial = false;
    let clientesComMargemCalculada = 0;
    for (const row of r.rows) {
      const cobradoCentavos = row.FATURA_VALOR_CENTAVOS !== null && row.FATURA_VALOR_CENTAVOS !== undefined
        ? Number(row.FATURA_VALOR_CENTAVOS)
        : (row.VALOR_RECORRENTE_CENTAVOS !== null && row.VALOR_RECORRENTE_CENTAVOS !== undefined
          ? Number(row.VALOR_RECORRENTE_CENTAVOS)
          : null);
      const custoDesconhecido = Number(row.CUSTO_DESCONHECIDO_CNT || 0) > 0;
      const margem = calcularMargemCentavos({ cobradoCentavos, custoCentavos: row.CUSTO_CENTAVOS, custoDesconhecido });
      if (margem === null) { margemParcial = true; continue; }
      margemCentavos += margem;
      clientesComMargemCalculada += 1;
    }
    return {
      competencia,
      mrrCentavos: mrr,
      aReceberCentavos: aReceber.aReceberCentavos,
      atrasadoCentavos: aReceber.atrasadoCentavos,
      faturasAtrasadas: aReceber.faturasAtrasadas,
      clientesAtivos: clientes.clientesAtivos,
      clientesSuspensos: clientes.clientesSuspensos,
      clientesImplantacao: clientes.clientesImplantacao,
      margemCentavos,
      margemParcial,
      clientesComMargemCalculada,
    };
  });
}

/** Faturas do mês de TODOS os clientes (lista de cobrança), opcionalmente
 *  filtradas por status (ex.: "atrasada"). */
async function listarFaturasDoMes({ competencia, status } = {}) {
  const comp = competencia || faturamento.anoMesAtual();
  return comOperador(async (conn) => {
    const filtroStatus = status ? 'AND f.status = :status' : '';
    const binds = status ? { competencia: comp, status } : { competencia: comp };
    const r = await conn.execute(
      `SELECT f.*, t.nome AS tenant_nome, t.slug AS tenant_slug, t.status AS tenant_status,
              COALESCE(pg.pago, 0) AS pago_centavos,
              (f.valor_total_centavos - COALESCE(pg.pago, 0)) AS saldo_centavos,
              CASE WHEN f.status = 'atrasada' THEN (CURRENT_DATE - f.vencimento) ELSE NULL END AS dias_vencida
         FROM fatura f
         JOIN tenant t ON t.id = f.tenant_id
         LEFT JOIN (SELECT fatura_id, SUM(valor_centavos) AS pago FROM pagamento GROUP BY fatura_id) pg
                ON pg.fatura_id = f.id
        WHERE f.competencia = :competencia ${filtroStatus}
        ORDER BY f.vencimento, t.nome`,
      binds
    );
    return r.rows.map((row) => ({
      id: Number(row.ID),
      tenantId: Number(row.TENANT_ID),
      tenantNome: row.TENANT_NOME,
      tenantSlug: row.TENANT_SLUG,
      tenantStatus: row.TENANT_STATUS,
      competencia: row.COMPETENCIA,
      vencimento: row.VENCIMENTO,
      status: row.STATUS,
      custoIncerto: row.CUSTO_INCERTO === true,
      valorTotalCentavos: Number(row.VALOR_TOTAL_CENTAVOS),
      pagoCentavos: Number(row.PAGO_CENTAVOS || 0),
      saldoCentavos: Number(row.SALDO_CENTAVOS),
      diasVencida: row.DIAS_VENCIDA === null || row.DIAS_VENCIDA === undefined ? null : Number(row.DIAS_VENCIDA),
    }));
  });
}

/** Implementações previstas e vencidas (ainda não entregues) — alerta cruzado
 *  entre tenants; não existe função equivalente em operador/implementacao.js
 *  (aquele módulo só olha um tenant por vez). */
async function listarImplementacoesVencidas() {
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `SELECT t.id AS tenant_id, t.nome AS tenant_nome, t.slug AS tenant_slug,
              i.status, i.data_prevista, (CURRENT_DATE - i.data_prevista) AS dias_vencida
         FROM (
           SELECT DISTINCT ON (tenant_id) tenant_id, status, data_prevista
             FROM implementacao
            ORDER BY tenant_id, criado_em DESC, id DESC
         ) i
         JOIN tenant t ON t.id = i.tenant_id
        WHERE i.data_prevista IS NOT NULL AND i.data_prevista < CURRENT_DATE AND i.status <> 'entregue'
        ORDER BY i.data_prevista`
    );
    return r.rows.map((row) => ({
      tenantId: Number(row.TENANT_ID),
      tenantNome: row.TENANT_NOME,
      tenantSlug: row.TENANT_SLUG,
      status: row.STATUS,
      dataPrevista: row.DATA_PREVISTA,
      diasVencida: Number(row.DIAS_VENCIDA),
    }));
  });
}

/** Clientes perto do teto de IA do plano (>= 80% do teto configurado) ou já
 *  estourados. Reusa tenants.listarComUso() — não reimplementa o cálculo do
 *  teto (ver operador/tenants.js). */
async function listarAlertasTetoIa() {
  const limiteAlerta = 0.8;
  const lista = await tenants.listarComUso();
  return lista
    .filter((row) => row.IA_TETO_TOKENS_MES !== null && row.IA_TETO_TOKENS_MES !== undefined && Number(row.IA_TETO_TOKENS_MES) > 0)
    .map((row) => {
      const teto = Number(row.IA_TETO_TOKENS_MES);
      const usados = Number(row.IA_TOKENS_USADOS_MES || 0);
      return {
        tenantId: Number(row.ID),
        tenantNome: row.NOME,
        tenantSlug: row.SLUG,
        tetoTokensMes: teto,
        tokensUsadosMes: usados,
        percentual: teto > 0 ? usados / teto : 0,
        tetoEstourado: row.IA_TETO_ESTOURADO === true,
      };
    })
    .filter((item) => item.percentual >= limiteAlerta)
    .sort((a, b) => b.percentual - a.percentual);
}

/** Os três alertas do painel: teto de IA perto do limite, atrasado há X dias
 *  (reusa fatura.listarInadimplencia — não reimplementa) e implementação
 *  prevista vencida. */
async function listarAlertas() {
  const [tetoIa, atrasados, implementacaoVencida] = await Promise.all([
    listarAlertasTetoIa(),
    fatura.listarInadimplencia(),
    listarImplementacoesVencidas(),
  ]);
  return { tetoIa, atrasados, implementacaoVencida };
}

module.exports = {
  calcularMargemCentavos,
  resumoGeral,
  listarClientesFinanceiro,
  listarFaturasDoMes,
  listarAlertas,
  listarAlertasTetoIa,
  listarImplementacoesVencidas,
};
