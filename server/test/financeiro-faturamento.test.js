// financeiro/faturamento.js — geração mensal de fatura + marcação de
// inadimplência (FIL-79). gerarFaturas/marcarAtrasadas são puras/injetáveis
// (recebem a conexão já aberta) — testadas aqui sem banco nem rede, mesmo
// padrão de consumo-fechamento.test.js.
//
// Competências usam SEMPRE datas relativas a `new Date()` (nunca literal tipo
// '2026-07'): desde o achado de review do PR #26, gerarFaturaDoTenant recusa
// qualquer competência >= mês corrente, então um literal fixo quebraria a
// suíte assim que o relógio real passasse daquele mês.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const faturamento = require('../financeiro/faturamento');

/** 'YYYY-MM' de N meses atrás de hoje (N=0 é o mês corrente). */
function competenciaRelativa(mesesAtras) {
  const d = new Date();
  d.setUTCDate(1); // evita overflow de dia ao subtrair meses (ex.: dia 31)
  d.setUTCMonth(d.getUTCMonth() - mesesAtras);
  return d.toISOString().slice(0, 7);
}

/** Simula tenant + contrato + contrato_item + consumo_mensal/evento +
 *  implementacao + fatura/fatura_item (idempotência de verdade via Map por
 *  tenant_id+competencia) + operador_auditoria. Reproduz em JS os mesmos
 *  filtros que o SQL real faz (item único não refaturado, parcela cancelada
 *  não conta) para os testes ficarem fiéis ao comportamento de produção. */
function conexao({
  tenants = [],
  contratosPorTenant = {},
  itensPorContrato = {},
  consumoPorTenant = {},
  implementacaoPorTenant = {},
  tenantsComErro = [],
} = {}) {
  const faturas = new Map(); // `${tenantId}:${competencia}` -> linha
  const faturaItens = [];
  const auditorias = [];
  const cap = [];
  let nextFaturaId = 1;
  let nextItemId = 1;

  function faturaPorId(id) {
    for (const row of faturas.values()) if (row.ID === id) return row;
    return null;
  }

  function faturadoENaoCancelado(origemTipo, origemId) {
    return faturaItens.some((fi) => {
      if (fi.ORIGEM_TIPO !== origemTipo || fi.ORIGEM_ID !== origemId) return false;
      const dono = faturaPorId(fi.FATURA_ID);
      return dono && dono.STATUS !== 'cancelada';
    });
  }

  return {
    faturas, faturaItens, auditorias, cap,
    async execute(sql, binds = {}) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      cap.push({ sql: s, binds });

      if (/^SAVEPOINT/i.test(s) || /^RELEASE SAVEPOINT/i.test(s) || /^ROLLBACK TO SAVEPOINT/i.test(s)) {
        return { rows: [] };
      }
      if (/^SELECT t\.id FROM tenant t WHERE t\.status = 'ativo'/i.test(s)) {
        const lista = binds.tenantId ? tenants.filter((t) => t === binds.tenantId) : tenants;
        return { rows: lista.map((id) => ({ ID: id })) };
      }
      if (/FROM contrato\s+WHERE tenant_id = :tenantId[\s\S]*to_char\(inicio_cobranca/i.test(s)) {
        const c = contratosPorTenant[binds.tenantId];
        if (!c) return { rows: [] };
        const inicio = String(c.INICIO_COBRANCA).slice(0, 7);
        const fim = c.FIM_VIGENCIA ? String(c.FIM_VIGENCIA).slice(0, 7) : null;
        if (binds.competencia < inicio) return { rows: [] };
        if (fim && binds.competencia > fim) return { rows: [] };
        return { rows: [c] };
      }
      if (/^SELECT id, tipo, descricao, valor_unitario_centavos, quantidade\s+FROM contrato_item/i.test(s)) {
        const todos = itensPorContrato[binds.contratoId] || [];
        const rows = todos.filter((item) => item.RECORRENTE === true || !faturadoENaoCancelado('contrato_item', item.ID));
        return { rows };
      }
      if (/FROM consumo_mensal/i.test(s)) {
        const chave = `${binds.tenantId}:${binds.competencia}`;
        return { rows: consumoPorTenant[chave] || [] };
      }
      if (/^SELECT id, valor_centavos, forma_pagamento, numero_parcelas\s+FROM implementacao/i.test(s)) {
        const impl = implementacaoPorTenant[binds.tenantId];
        return { rows: impl ? [impl] : [] };
      }
      if (/fi\.origem_tipo = 'implementacao' AND fi\.origem_id = :id/i.test(s)) {
        const cnt = faturaItens.filter((it) => it.ORIGEM_TIPO === 'implementacao' && it.ORIGEM_ID === binds.id
          && (faturaPorId(it.FATURA_ID) || {}).STATUS !== 'cancelada').length;
        return { rows: [{ CNT: cnt }] };
      }
      if (/^INSERT INTO fatura \(/i.test(s)) {
        if (tenantsComErro.includes(binds.tenantId)) throw new Error(`falha simulada no tenant ${binds.tenantId}`);
        const chave = `${binds.tenantId}:${binds.competencia}`;
        if (faturas.has(chave)) return { rows: [] }; // ON CONFLICT DO NOTHING
        const id = nextFaturaId++;
        const row = {
          ID: id, TENANT_ID: binds.tenantId, COMPETENCIA: binds.competencia, VENCIMENTO: binds.vencimento,
          VALOR_TOTAL_CENTAVOS: binds.valorTotalCentavos, STATUS: 'prevista', CUSTO_INCERTO: binds.custoIncerto,
          OBSERVACOES: binds.observacoes,
        };
        faturas.set(chave, row);
        return { rows: [{ ID: id }] };
      }
      if (/^INSERT INTO fatura_item/i.test(s)) {
        const item = {
          ID: nextItemId++, FATURA_ID: binds.faturaId, TIPO: binds.tipo, DESCRICAO: binds.descricao,
          QUANTIDADE: binds.quantidade, VALOR_UNITARIO_CENTAVOS: binds.valorUnitario, VALOR_TOTAL_CENTAVOS: binds.valorTotal,
          ORIGEM_TIPO: binds.origemTipo, ORIGEM_ID: binds.origemId,
        };
        faturaItens.push(item);
        return { rows: [item] };
      }
      if (/^INSERT INTO operador_auditoria/i.test(s)) {
        auditorias.push(binds);
        return { rows: [] };
      }
      if (/^UPDATE fatura SET status = 'atrasada'/i.test(s)) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - Number(binds.dias));
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        const out = [];
        for (const row of faturas.values()) {
          if (row.STATUS === 'emitida' && row.VENCIMENTO < cutoffStr) {
            row.STATUS = 'atrasada';
            out.push({ ID: row.ID, TENANT_ID: row.TENANT_ID });
          }
        }
        return { rows: out };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function contratoMensal({ inicioCobranca, fimVigencia = null } = {}) {
  return {
    ID: 10, PLANO_NOME: 'Plano Pro', VALOR_RECORRENTE_CENTAVOS: 100000, CICLO: 'mensal',
    DIA_VENCIMENTO: 10, INICIO_COBRANCA: inicioCobranca, FIM_VIGENCIA: fimVigencia,
  };
}

const COMPETENCIA_FECHADA = competenciaRelativa(1); // mês passado — sempre encerrado
const CONTRATO_5 = contratoMensal({ inicioCobranca: `${competenciaRelativa(6)}-01` });

// ===========================================================================
// SÓ GERA COMPETÊNCIA JÁ ENCERRADA (critério de aceite / achado de review)
// ===========================================================================
test('CONGELAMENTO CEDO (achado de review): competência do mês corrente NÃO gera fatura', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const r = await faturamento.gerarFaturaDoTenant(conn, 5, faturamento.anoMesAtual());
  assert.equal(r, null);
  assert.equal(conn.faturas.size, 0);
});

test('CONGELAMENTO CEDO: competência futura também não gera fatura', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const [ano, mes] = faturamento.anoMesAtual().split('-').map(Number);
  const futuro = `${mes === 12 ? ano + 1 : ano}-${String(mes === 12 ? 1 : mes + 1).padStart(2, '0')}`;
  const r = await faturamento.gerarFaturaDoTenant(conn, 5, futuro);
  assert.equal(r, null);
});

test('competência já encerrada (mês anterior) gera fatura normalmente', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const r = await faturamento.gerarFaturaDoTenant(conn, 5, COMPETENCIA_FECHADA);
  assert.ok(r, 'competência encerrada deveria gerar fatura');
  assert.equal(r.valorTotalCentavos, 100000);
});

test('tick() usa mesAnteriorDe — nunca anoMesAtual (fonte do achado de congelamento cedo)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'financeiro', 'faturamento.js'), 'utf8');
  const tickBody = src.slice(src.indexOf('async function tick()'), src.indexOf('function iniciar()'));
  assert.ok(/mesAnteriorDe\(new Date\(\)\)/.test(tickBody), 'tick() deve gerar a competência do mês anterior, não a corrente');
  assert.ok(!/gerarFaturas\(conn, anoMesAtual\(\)\)/.test(tickBody), 'tick() não pode mais gerar o mês corrente');
});

test('mesAnteriorDe: competência em UTC, formato YYYY-MM', () => {
  assert.equal(faturamento.mesAnteriorDe(new Date(Date.UTC(2026, 6, 15))), '2026-06');
  assert.equal(faturamento.mesAnteriorDe(new Date(Date.UTC(2026, 0, 15))), '2025-12', 'virada de ano');
});

// ===========================================================================
// Idempotência + freeze (critérios de aceite)
// ===========================================================================
test('gerarFaturas: gera a fatura prevista com a recorrência do contrato', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const geradas = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(geradas.length, 1);
  assert.equal(geradas[0].valorTotalCentavos, 100000);
  const fatura = conn.faturas.get(`5:${COMPETENCIA_FECHADA}`);
  assert.equal(fatura.STATUS, 'prevista');
  assert.equal(fatura.VENCIMENTO, `${COMPETENCIA_FECHADA}-10`);
  const itens = conn.faturaItens.filter((it) => it.FATURA_ID === fatura.ID);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].TIPO, 'recorrencia');
});

test('IDEMPOTÊNCIA (critério de aceite): rodar gerarFaturas duas vezes para a mesma competência não duplica', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const primeira = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(primeira.length, 1);
  const segunda = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(segunda.length, 0, 'a segunda passada não deveria gerar nada novo');
  assert.equal(conn.faturas.size, 1, 'não deveria ter nascido uma segunda fatura');
  assert.equal(conn.faturaItens.length, 1, 'não deveria ter nascido um segundo item');
});

test('tenant com inicio_cobranca futuro não gera fatura (critério de aceite)', async () => {
  const contratoFuturo = contratoMensal({ inicioCobranca: `${competenciaRelativa(-2)}-01` }); // 2 meses à frente
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: contratoFuturo } });
  const geradas = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(geradas.length, 0);
  assert.equal(conn.faturas.size, 0);
});

test('tenant sem contrato vigente não gera fatura', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: {} });
  const geradas = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(geradas.length, 0);
});

test('FATURA FECHADA NÃO MUDA DE VALOR (critério de aceite): alterar o contrato depois não afeta a fatura já gerada', async () => {
  const contratosPorTenant = { 5: CONTRATO_5 };
  const conn = conexao({ tenants: [5], contratosPorTenant });
  await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(conn.faturas.get(`5:${COMPETENCIA_FECHADA}`).VALOR_TOTAL_CENTAVOS, 100000);

  // "Contrato alterado depois" (equivalente a criarOuTrocarContrato mudando o
  // valor recorrente vigente) — a fatura já foi gerada e congelada.
  contratosPorTenant[5] = { ...CONTRATO_5, VALOR_RECORRENTE_CENTAVOS: 999999 };
  await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA); // roda de novo — mesma competência

  assert.equal(conn.faturas.get(`5:${COMPETENCIA_FECHADA}`).VALOR_TOTAL_CENTAVOS, 100000, 'a fatura já gerada não pode mudar');
  const itens = conn.faturaItens.filter((it) => it.FATURA_ID === conn.faturas.get(`5:${COMPETENCIA_FECHADA}`).ID);
  assert.equal(itens.length, 1, 'não deveria ter regravado nem duplicado itens');
});

// ===========================================================================
// Itens do contrato — recorrentes TODA competência; únicos, uma vez só
// (achado de review: itens recorrente=false nunca eram faturados).
// ===========================================================================
test('gerarFaturas: soma os itens recorrentes do contrato (desconto reduz o total)', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    itensPorContrato: {
      10: [
        { ID: 1, TIPO: 'addon_ia', DESCRICAO: 'Add-on de IA', VALOR_UNITARIO_CENTAVOS: 5000, QUANTIDADE: 1, RECORRENTE: true },
        { ID: 2, TIPO: 'desconto', DESCRICAO: 'Desconto fidelidade', VALOR_UNITARIO_CENTAVOS: -2000, QUANTIDADE: 1, RECORRENTE: true },
      ],
    },
  });
  const [fatura] = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(fatura.valorTotalCentavos, 100000 + 5000 - 2000);
});

test('ITEM ÚNICO (achado de review): recorrente=false entra em EXATAMENTE uma fatura', async () => {
  const itensPorContrato = {
    10: [{ ID: 3, TIPO: 'avulso', DESCRICAO: 'Setup de integração extra', VALOR_UNITARIO_CENTAVOS: 30000, QUANTIDADE: 1, RECORRENTE: false }],
  };
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 }, itensPorContrato });

  const mesA = competenciaRelativa(3);
  const mesB = competenciaRelativa(2);

  const [faturaA] = await faturamento.gerarFaturas(conn, mesA);
  assert.equal(faturaA.valorTotalCentavos, 100000 + 30000, 'o item único entra na primeira fatura gerada');
  const itemA = conn.faturaItens.find((it) => it.ORIGEM_TIPO === 'contrato_item' && it.ORIGEM_ID === 3);
  assert.ok(itemA, 'o item único precisa aparecer em algum fatura_item');

  const [faturaB] = await faturamento.gerarFaturas(conn, mesB);
  assert.equal(faturaB.valorTotalCentavos, 100000, 'a competência seguinte NÃO cobra o item único de novo');
  const itensOrigem3 = conn.faturaItens.filter((it) => it.ORIGEM_TIPO === 'contrato_item' && it.ORIGEM_ID === 3);
  assert.equal(itensOrigem3.length, 1, 'o item único só pode existir em UMA fatura no total');
});

// ===========================================================================
// Ciclo do contrato — mensal sempre, trimestral/anual só na virada
// (achado de review: ciclo era ignorado, cobrando plano anual 12x).
// ===========================================================================
test('CICLO MENSAL: cobra a recorrência em toda competência', async () => {
  const contrato = contratoMensal({ inicioCobranca: `${competenciaRelativa(3)}-01` });
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: contrato } });
  for (const meses of [3, 2, 1]) {
    const r = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(meses));
    assert.ok(r, `mês ${meses} atrás deveria cobrar (ciclo mensal)`);
    assert.equal(r.valorTotalCentavos, 100000);
  }
});

test('CICLO TRIMESTRAL (achado de review, teste dos 3 ciclos): cobra só a cada 3 meses desde inicio_cobranca', async () => {
  const contrato = { ...contratoMensal({ inicioCobranca: `${competenciaRelativa(6)}-01` }), CICLO: 'trimestral' };
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: contrato } });

  const r6 = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(6)); // mês 0 do ciclo — cobra
  assert.ok(r6, 'competência de início do ciclo deveria cobrar');
  const r5 = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(5)); // mês 1 — não cobra
  assert.equal(r5, null, 'um mês depois do início não é virada de trimestre — sem item, sem fatura');
  const r4 = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(4)); // mês 2 — não cobra
  assert.equal(r4, null);
  const r3 = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(3)); // mês 3 — cobra de novo
  assert.ok(r3, 'terceiro mês fecha o trimestre — deveria cobrar');
  assert.equal(r3.valorTotalCentavos, 100000);
});

test('CICLO ANUAL (achado de review, teste dos 3 ciclos): cobra só a cada 12 meses desde inicio_cobranca', async () => {
  const contrato = { ...contratoMensal({ inicioCobranca: `${competenciaRelativa(12)}-01` }), CICLO: 'anual' };
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: contrato } });

  const r12 = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(12));
  assert.ok(r12, 'competência de início do ciclo anual deveria cobrar');
  const r6 = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(6));
  assert.equal(r6, null, 'meio do ciclo anual não é virada — sem cobrança');
  const r1 = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(1));
  assert.equal(r1, null, 'ainda dentro do primeiro ano — sem cobrança');
});

test('deveCobrarRecorrencia: função pura, cobre os 3 ciclos', () => {
  assert.equal(faturamento.deveCobrarRecorrencia('2026-01-01', '2026-01', 'mensal'), true);
  assert.equal(faturamento.deveCobrarRecorrencia('2026-01-01', '2026-02', 'mensal'), true);
  assert.equal(faturamento.deveCobrarRecorrencia('2026-01-01', '2026-04', 'trimestral'), true);
  assert.equal(faturamento.deveCobrarRecorrencia('2026-01-01', '2026-02', 'trimestral'), false);
  assert.equal(faturamento.deveCobrarRecorrencia('2026-01-01', '2027-01', 'anual'), true);
  assert.equal(faturamento.deveCobrarRecorrencia('2026-01-01', '2026-12', 'anual'), false);
  assert.equal(faturamento.deveCobrarRecorrencia('2026-06-01', '2026-01', 'mensal'), false, 'competência antes do início nunca cobra');
});

test('fatura sem NENHUM item aplicável não é gerada (nada a cobrar não é fatura de R$0)', async () => {
  const contrato = { ...contratoMensal({ inicioCobranca: `${competenciaRelativa(6)}-01` }), CICLO: 'anual' };
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: contrato } });
  const r = await faturamento.gerarFaturaDoTenant(conn, 5, competenciaRelativa(3)); // fora da virada anual, sem outra cobrança
  assert.equal(r, null);
  assert.equal(conn.faturas.size, 0);
});

// ===========================================================================
// Excedente do consumo — custo desconhecido NUNCA vira zero silencioso.
// ===========================================================================
test('gerarFaturas: excedente do consumo medido vira item de fatura', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    consumoPorTenant: { [`5:${COMPETENCIA_FECHADA}`]: [{ TIPO: 'ia_tokens', QUANTIDADE: 5000, CUSTO_CENTAVOS: 1250 }] },
  });
  const [fatura] = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(fatura.valorTotalCentavos, 100000 + 1250);
  assert.equal(fatura.custoIncerto, false);
  const item = conn.faturaItens.find((it) => it.TIPO === 'excedente');
  assert.ok(item, 'devia ter criado o item de excedente');
  assert.equal(item.VALOR_TOTAL_CENTAVOS, 1250);
});

test('CUSTO DESCONHECIDO NUNCA ASSUME ZERO: sinaliza custo_incerto quando consumo_mensal.custo_incompleto vem true (migração 019)', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    consumoPorTenant: {
      [`5:${COMPETENCIA_FECHADA}`]: [{ TIPO: 'ia_tokens', QUANTIDADE: 5000, CUSTO_CENTAVOS: 800, CUSTO_INCOMPLETO: true }],
    },
  });
  const [fatura] = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(fatura.custoIncerto, true, 'a fatura tem que ficar sinalizada para revisão');
  // O valor gerado é a soma do que É CONHECIDO — nunca inventado como zero.
  assert.equal(fatura.valorTotalCentavos, 100000 + 800);
  const faturaRow = conn.faturas.get(`5:${COMPETENCIA_FECHADA}`);
  assert.match(String(faturaRow.OBSERVACOES), /custo desconhecido/i);
});

test('sem consumo no período: não cria item de excedente e custo_incerto fica false', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const [fatura] = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(fatura.custoIncerto, false);
  assert.ok(!conn.faturaItens.some((it) => it.TIPO === 'excedente'));
});

// ===========================================================================
// Parcela de implementação — cobra uma a mais por competência; a última
// absorve o resto da divisão; fatura cancelada libera a parcela de volta
// (achado de review).
// ===========================================================================
test('implementação parcelada: cobra uma parcela por competência até completar; última absorve o resto', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    implementacaoPorTenant: { 5: { ID: 77, VALOR_CENTAVOS: 10000, FORMA_PAGAMENTO: 'parcelado', NUMERO_PARCELAS: 3 } },
  });
  const [f1] = await faturamento.gerarFaturas(conn, competenciaRelativa(4));
  const [f2] = await faturamento.gerarFaturas(conn, competenciaRelativa(3));
  const [f3] = await faturamento.gerarFaturas(conn, competenciaRelativa(2));
  const [f4] = await faturamento.gerarFaturas(conn, competenciaRelativa(1)); // já completou as 3 parcelas

  const parcelas = conn.faturaItens.filter((it) => it.ORIGEM_TIPO === 'implementacao').map((it) => it.VALOR_TOTAL_CENTAVOS);
  assert.deepEqual(parcelas, [3333, 3333, 3334]);
  assert.equal(parcelas.reduce((a, b) => a + b, 0), 10000, 'a soma das parcelas bate o valor total, sem perder centavo');
  assert.equal(f4.valorTotalCentavos, 100000, 'quarta competência não cobra mais nenhuma parcela');
  void f1; void f2; void f3;
});

test('implementação à vista: cobra uma única vez', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    implementacaoPorTenant: { 5: { ID: 78, VALOR_CENTAVOS: 200000, FORMA_PAGAMENTO: 'a_vista', NUMERO_PARCELAS: null } },
  });
  const [f1] = await faturamento.gerarFaturas(conn, competenciaRelativa(2));
  const [f2] = await faturamento.gerarFaturas(conn, competenciaRelativa(1));
  assert.equal(f1.valorTotalCentavos, 100000 + 200000);
  assert.equal(f2.valorTotalCentavos, 100000, 'segunda competência não cobra a implementação de novo');
});

test('CANCELAMENTO LIBERA A PARCELA (achado de review): fatura cancelada não conta como parcela faturada', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    implementacaoPorTenant: { 5: { ID: 79, VALOR_CENTAVOS: 9000, FORMA_PAGAMENTO: 'parcelado', NUMERO_PARCELAS: 3 } },
  });
  const mes1 = competenciaRelativa(3);
  const mes2 = competenciaRelativa(2);

  const [f1] = await faturamento.gerarFaturas(conn, mes1);
  assert.ok(conn.faturaItens.some((it) => it.ORIGEM_TIPO === 'implementacao' && it.FATURA_ID === f1.id));

  // Cancela a fatura que continha a 1ª parcela (equivalente a operador/fatura.js::cancelarFatura).
  conn.faturas.get(`5:${mes1}`).STATUS = 'cancelada';

  const [f2] = await faturamento.gerarFaturas(conn, mes2);
  const itemF2 = conn.faturaItens.find((it) => it.ORIGEM_TIPO === 'implementacao' && it.FATURA_ID === f2.id);
  assert.ok(itemF2, 'a próxima geração deveria refaturar a parcela liberada pelo cancelamento');
  assert.equal(itemF2.DESCRICAO, 'Implementação — parcela 1/3', 'a parcela cancelada volta a ser a 1ª, não a 2ª');
});

// ===========================================================================
// Escrita "best-effort" por tenant — SAVEPOINT isola falha de um tenant.
// ===========================================================================
test('um tenant com erro não derruba a geração dos demais (SAVEPOINT)', async () => {
  const conn = conexao({
    tenants: [5, 6],
    contratosPorTenant: { 5: CONTRATO_5, 6: { ...CONTRATO_5, ID: 11 } },
    tenantsComErro: [5],
  });
  const geradas = await faturamento.gerarFaturas(conn, COMPETENCIA_FECHADA);
  assert.equal(geradas.length, 1, 'só o tenant 6 deveria ter gerado fatura');
  assert.equal(geradas[0].tenantId, 6);
  assert.ok(conn.cap.some((c) => /^ROLLBACK TO SAVEPOINT/i.test(c.sql)), 'deveria ter isolado a falha do tenant 5 com ROLLBACK TO SAVEPOINT');
});

// ===========================================================================
// Inadimplência — atrasada é automática; suspensão nunca é.
// ===========================================================================
test('marcarAtrasadas: fatura emitida vencida há mais de N dias vira atrasada', async () => {
  const conn = conexao({});
  const vencidaHa10Dias = new Date();
  vencidaHa10Dias.setDate(vencidaHa10Dias.getDate() - 10);
  conn.faturas.set('5:2026-06', {
    ID: 900, TENANT_ID: 5, COMPETENCIA: '2026-06', VENCIMENTO: vencidaHa10Dias.toISOString().slice(0, 10),
    VALOR_TOTAL_CENTAVOS: 1000, STATUS: 'emitida',
  });
  const naoVencidaAinda = new Date();
  naoVencidaAinda.setDate(naoVencidaAinda.getDate() + 5);
  conn.faturas.set('6:2026-07', {
    ID: 901, TENANT_ID: 6, COMPETENCIA: '2026-07', VENCIMENTO: naoVencidaAinda.toISOString().slice(0, 10),
    VALOR_TOTAL_CENTAVOS: 1000, STATUS: 'emitida',
  });

  const n = await faturamento.marcarAtrasadas(conn, 5);
  assert.equal(n, 1);
  assert.equal(conn.faturas.get('5:2026-06').STATUS, 'atrasada');
  assert.equal(conn.faturas.get('6:2026-07').STATUS, 'emitida', 'ainda não venceu há dias suficientes');
  assert.ok(
    conn.auditorias.some((a) => a.acao === 'fatura_atrasada' && a.entId === 900),
    'marcar atrasada tem que ficar em auditoria'
  );
});

test('marcarAtrasadas nunca suspende o tenant — só sinaliza (sugestão fica na listagem do operador)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'financeiro', 'faturamento.js'), 'utf8');
  assert.ok(!/alterarStatus|suspender/i.test(src), 'financeiro/faturamento.js não pode chamar suspensão automaticamente');
});

// ===========================================================================
// Funções puras auxiliares
// ===========================================================================
test('valorDaParcela: distribui o resto na última parcela', () => {
  assert.equal(faturamento.valorDaParcela(10000, 3, 1), 3333);
  assert.equal(faturamento.valorDaParcela(10000, 3, 2), 3333);
  assert.equal(faturamento.valorDaParcela(10000, 3, 3), 3334);
  assert.equal(faturamento.valorDaParcela(10000, 2, 1), 5000);
  assert.equal(faturamento.valorDaParcela(10000, 2, 2), 5000);
});

test('vencimentoDe: monta a data a partir da competência + dia de vencimento', () => {
  assert.equal(faturamento.vencimentoDe('2026-08', 10), '2026-08-10');
  assert.equal(faturamento.vencimentoDe('2026-01', 5), '2026-01-05');
});

test('anoMesAtual: formato YYYY-MM', () => {
  assert.match(faturamento.anoMesAtual(), /^\d{4}-\d{2}$/);
});
