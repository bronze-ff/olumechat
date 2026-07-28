'use strict';
// financeiro/painel.js — painel financeiro do operador (FIL-80). Mesmo padrão
// de teste de operador-fatura.test.js: comOperador roda via db.getConnection
// (duble), sem RLS/banco real. As rotas GET /api/operador/financeiro/* já
// caem sozinhas no teste de fronteira de sessão (operador-acesso.test.js —
// introspecção do router), então aqui o foco é a AGREGAÇÃO em si: MRR, a
// receber, atrasado e — principalmente — que custo desconhecido NUNCA vira
// zero na margem.
process.env.META_APP_SECRET = 'x'; process.env.WEBHOOK_VERIFY_TOKEN = 'x'; process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = 'x'; process.env.WA_BUSINESS_ACCOUNT_ID = 'x';
process.env.JWT_SECRET = 'seg-teste-32-chars-abcdefghijk';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const painel = require('../financeiro/painel');

function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

/** Fake conn que despacha por trecho distintivo do SQL — mesmo estilo de
 *  operador-fatura.test.js, adaptado para várias queries de agregação. */
function conexao(handlers) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      const s = norm(sql);
      cap.push({ sql: s, binds });
      if (/set_config/.test(s)) return { rows: [] };
      for (const [marcador, handler] of handlers) {
        if (s.includes(marcador)) return handler(binds);
      }
      throw new Error(`SQL não previsto no teste: ${s}`);
    },
    async commit() {}, async rollback() {}, async close() {},
  };
}

test.afterEach(() => { delete db.getConnection; });

// ===========================================================================
// calcularMargemCentavos — função pura (o cerne do critério de aceite).
// ===========================================================================
test('margem = cobrado - custo, mas nunca finge custo desconhecido como zero', () => {
  assert.equal(painel.calcularMargemCentavos({ cobradoCentavos: 10000, custoCentavos: 4000, custoDesconhecido: false }), 6000);
  assert.equal(painel.calcularMargemCentavos({ cobradoCentavos: 10000, custoCentavos: 0, custoDesconhecido: true }), null,
    'custo desconhecido não pode virar 0 — a margem tem que ficar indisponível');
  assert.equal(painel.calcularMargemCentavos({ cobradoCentavos: null, custoCentavos: 0, custoDesconhecido: false }), null,
    'sem valor cobrado (nenhum contrato/fatura) não há margem para calcular');
});

// ===========================================================================
// resumoGeral — MRR, a receber, atrasado, contagem de clientes, margem.
// ===========================================================================
test('resumoGeral soma MRR (contrato + itens recorrentes) e margem só dos clientes com custo conhecido', async () => {
  const conn = conexao([
    ['SELECT COALESCE(SUM(c.valor_recorrente_centavos), 0) AS total', () => ({ rows: [{ TOTAL: 100000 }] })],
    ['SELECT COALESCE(SUM(ci.valor_unitario_centavos * ci.quantidade), 0) AS total', () => ({ rows: [{ TOTAL: 20000 }] })],
    ['COALESCE(SUM(CASE WHEN f.status <> \'cancelada\'', () => ({
      rows: [{ A_RECEBER: 150000, ATRASADO: 30000, ATRASADAS_COUNT: 2 }],
    })],
    ['SELECT status, COUNT(*) AS cnt FROM tenant GROUP BY status', () => ({
      rows: [{ STATUS: 'ativo', CNT: 3 }, { STATUS: 'suspenso', CNT: 1 }, { STATUS: 'encerrado', CNT: 2 }],
    })],
    ['DISTINCT ON (i.tenant_id)', () => ({ rows: [{ CNT: 1 }] })],
    ['t.status AS tenant_status, c.valor_recorrente_centavos, f.valor_total_centavos AS fatura_valor_centavos, ce.custo_centavos, ce.custo_desconhecido_cnt', () => ({
      rows: [
        // A: fatura já gerada este mês, custo integralmente conhecido.
        { TENANT_ID: 1, TENANT_STATUS: 'ativo', VALOR_RECORRENTE_CENTAVOS: 100000, FATURA_VALOR_CENTAVOS: 110000, CUSTO_CENTAVOS: 40000, CUSTO_DESCONHECIDO_CNT: 0 },
        // B: sem fatura ainda este mês — cobrado cai para o valor do contrato.
        { TENANT_ID: 2, TENANT_STATUS: 'ativo', VALOR_RECORRENTE_CENTAVOS: 50000, FATURA_VALOR_CENTAVOS: null, CUSTO_CENTAVOS: 10000, CUSTO_DESCONHECIDO_CNT: 0 },
        // C: tem evento de consumo com custo NULL (preço não cadastrado) — margem indisponível.
        { TENANT_ID: 3, TENANT_STATUS: 'ativo', VALOR_RECORRENTE_CENTAVOS: 80000, FATURA_VALOR_CENTAVOS: 90000, CUSTO_CENTAVOS: 5000, CUSTO_DESCONHECIDO_CNT: 2 },
      ],
    })],
  ]);
  db.getConnection = async () => conn;

  const r = await painel.resumoGeral();
  assert.equal(r.mrrCentavos, 120000);
  assert.equal(r.aReceberCentavos, 150000);
  assert.equal(r.atrasadoCentavos, 30000);
  assert.equal(r.faturasAtrasadas, 2);
  assert.equal(r.clientesAtivos, 3);
  assert.equal(r.clientesSuspensos, 1);
  assert.equal(r.clientesImplantacao, 1);
  assert.equal(r.margemCentavos, 70000 + 40000, 'só A (70000) e B (40000) entram — C ficou de fora por custo desconhecido');
  assert.equal(r.margemParcial, true, 'C tem custo desconhecido — o resumo precisa sinalizar que a margem é parcial');
  assert.equal(r.clientesComMargemCalculada, 2);
});

// ===========================================================================
// listarClientesFinanceiro — cobrado x custo x margem por cliente.
// ===========================================================================
test('listarClientesFinanceiro mapeia cobrado/custo/margem e marca custo desconhecido sem custo virar zero', async () => {
  const conn = conexao([
    ['f.id AS fatura_id, f.status AS fatura_status', (binds) => {
      assert.equal(binds.competencia, '2026-07');
      return {
        rows: [
          { TENANT_ID: 10, TENANT_NOME: 'Acme', TENANT_SLUG: 'acme', TENANT_STATUS: 'ativo',
            PLANO_NOME: 'Pro', VALOR_RECORRENTE_CENTAVOS: 50000,
            FATURA_ID: 900, FATURA_STATUS: 'emitida', FATURA_VALOR_CENTAVOS: 52000,
            CUSTO_CENTAVOS: 8000, CUSTO_DESCONHECIDO_CNT: 0 },
          { TENANT_ID: 11, TENANT_NOME: 'Beta', TENANT_SLUG: 'beta', TENANT_STATUS: 'suspenso',
            PLANO_NOME: null, VALOR_RECORRENTE_CENTAVOS: null,
            FATURA_ID: null, FATURA_STATUS: null, FATURA_VALOR_CENTAVOS: null,
            CUSTO_CENTAVOS: 3000, CUSTO_DESCONHECIDO_CNT: 1 },
        ],
      };
    }],
  ]);
  db.getConnection = async () => conn;

  const lista = await painel.listarClientesFinanceiro({ competencia: '2026-07' });
  assert.equal(lista.length, 2);
  assert.deepEqual(lista[0], {
    tenantId: 10, tenantNome: 'Acme', tenantSlug: 'acme', tenantStatus: 'ativo',
    planoNome: 'Pro', faturaId: 900, faturaStatus: 'emitida',
    cobradoCentavos: 52000, custoCentavos: 8000, custoDesconhecido: false, margemCentavos: 44000,
  });
  assert.deepEqual(lista[1], {
    tenantId: 11, tenantNome: 'Beta', tenantSlug: 'beta', tenantStatus: 'suspenso',
    planoNome: null, faturaId: null, faturaStatus: null,
    cobradoCentavos: null, custoCentavos: 3000, custoDesconhecido: true, margemCentavos: null,
  });
});

// ===========================================================================
// listarFaturasDoMes — lista de cobrança, com filtro de status.
// ===========================================================================
test('listarFaturasDoMes calcula saldo e dias de atraso, e aplica o filtro de status na query', async () => {
  let sqlCapturado = null;
  const conn = conexao([
    ['pago_centavos', (binds) => {
      sqlCapturado = binds;
      return {
        rows: [
          { ID: 1, TENANT_ID: 10, TENANT_NOME: 'Acme', TENANT_SLUG: 'acme', TENANT_STATUS: 'ativo',
            COMPETENCIA: '2026-07', VENCIMENTO: '2026-07-10', STATUS: 'atrasada', CUSTO_INCERTO: false,
            VALOR_TOTAL_CENTAVOS: 50000, PAGO_CENTAVOS: 20000, SALDO_CENTAVOS: 30000, DIAS_VENCIDA: 6 },
        ],
      };
    }],
  ]);
  db.getConnection = async () => conn;

  const lista = await painel.listarFaturasDoMes({ competencia: '2026-07', status: 'atrasada' });
  assert.equal(sqlCapturado.status, 'atrasada');
  assert.equal(sqlCapturado.competencia, '2026-07');
  assert.deepEqual(lista[0], {
    id: 1, tenantId: 10, tenantNome: 'Acme', tenantSlug: 'acme', tenantStatus: 'ativo',
    competencia: '2026-07', vencimento: '2026-07-10', status: 'atrasada', custoIncerto: false,
    valorTotalCentavos: 50000, pagoCentavos: 20000, saldoCentavos: 30000, diasVencida: 6,
  });
});

// ===========================================================================
// listarAlertas — teto de IA perto do limite, atrasados, implementação vencida.
// ===========================================================================
test('listarAlertas junta teto de IA (>=80%), inadimplência (reusa fatura.listarInadimplencia) e implementação vencida', async () => {
  const conn = conexao([
    // tenants.listarComUso()
    ['t.id, t.nome, t.slug, t.status, t.criado_em, t.ia_habilitada,', () => ({
      rows: [
        { ID: 1, NOME: 'Acme', SLUG: 'acme', IA_TETO_TOKENS_MES: 1000, IA_TOKENS_USADOS_MES: 850, IA_TETO_ESTOURADO: false },
        { ID: 2, NOME: 'Beta', SLUG: 'beta', IA_TETO_TOKENS_MES: 1000, IA_TOKENS_USADOS_MES: 400, IA_TETO_ESTOURADO: false },
        { ID: 3, NOME: 'Gama', SLUG: 'gama', IA_TETO_TOKENS_MES: null, IA_TOKENS_USADOS_MES: 0, IA_TETO_ESTOURADO: false },
      ],
    })],
    // fatura.listarInadimplencia()
    ["WHERE f.status = 'atrasada' ORDER BY f.vencimento", () => ({
      rows: [{ ID: 5, TENANT_ID: 1, TENANT_NOME: 'Acme', TENANT_SLUG: 'acme', TENANT_STATUS: 'ativo', DIAS_VENCIDA: 9 }],
    })],
    // listarImplementacoesVencidas()
    ['dias_vencida FROM ( SELECT DISTINCT ON (tenant_id) tenant_id, status, data_prevista', () => ({
      rows: [{ TENANT_ID: 2, TENANT_NOME: 'Beta', TENANT_SLUG: 'beta', STATUS: 'em_andamento', DATA_PREVISTA: '2026-07-01', DIAS_VENCIDA: 27 }],
    })],
  ]);
  db.getConnection = async () => conn;

  const r = await painel.listarAlertas();
  assert.equal(r.tetoIa.length, 1, 'só Acme está em 85% (>=80%) — Beta em 40% e Gama sem teto ficam de fora');
  assert.equal(r.tetoIa[0].tenantId, 1);
  assert.ok(Math.abs(r.tetoIa[0].percentual - 0.85) < 1e-9);
  assert.equal(r.atrasados.length, 1);
  assert.equal(r.atrasados[0].tenantId, 1);
  assert.equal(r.implementacaoVencida.length, 1);
  assert.equal(r.implementacaoVencida[0].tenantId, 2);
  assert.equal(r.implementacaoVencida[0].diasVencida, 27);
});
