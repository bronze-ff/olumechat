// financeiro/faturamento.js — geração mensal de fatura + marcação de
// inadimplência (FIL-79). gerarFaturas/marcarAtrasadas são puras/injetáveis
// (recebem a conexão já aberta) — testadas aqui sem banco nem rede, mesmo
// padrão de consumo-fechamento.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const faturamento = require('../financeiro/faturamento');

/** Simula tenant + contrato + contrato_item + consumo_mensal/evento +
 *  implementacao + fatura/fatura_item (idempotência de verdade via Map por
 *  tenant_id+competencia) + operador_auditoria. */
function conexao({
  tenants = [],
  contratosPorTenant = {},
  itensPorContrato = {},
  consumoPorTenant = {},
  custoDesconhecidoPorTenant = {},
  implementacaoPorTenant = {},
  tenantsComErro = [],
} = {}) {
  const faturas = new Map(); // `${tenantId}:${competencia}` -> linha
  const faturaItens = [];
  const auditorias = [];
  const cap = [];
  let nextFaturaId = 1;
  let nextItemId = 1;

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
        return { rows: itensPorContrato[binds.contratoId] || [] };
      }
      if (/FROM consumo_mensal/i.test(s)) {
        const chave = `${binds.tenantId}:${binds.competencia}`;
        return { rows: consumoPorTenant[chave] || [] };
      }
      if (/FROM consumo_evento[\s\S]*custo_centavos IS NULL/i.test(s)) {
        const chave = `${binds.tenantId}:${binds.competencia}`;
        return { rows: [{ CNT: custoDesconhecidoPorTenant[chave] || 0 }] };
      }
      if (/^SELECT id, valor_centavos, forma_pagamento, numero_parcelas\s+FROM implementacao/i.test(s)) {
        const impl = implementacaoPorTenant[binds.tenantId];
        return { rows: impl ? [impl] : [] };
      }
      if (/FROM fatura_item WHERE origem_tipo = 'implementacao'/i.test(s)) {
        const cnt = faturaItens.filter((it) => it.ORIGEM_TIPO === 'implementacao' && it.ORIGEM_ID === binds.id).length;
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

const CONTRATO_5 = {
  ID: 10, PLANO_NOME: 'Plano Pro', VALOR_RECORRENTE_CENTAVOS: 100000, CICLO: 'mensal',
  DIA_VENCIMENTO: 10, INICIO_COBRANCA: '2026-06-01', FIM_VIGENCIA: null,
};

// ===========================================================================
// Geração básica + idempotência (critério de aceite)
// ===========================================================================
test('gerarFaturas: gera a fatura prevista com a recorrência do contrato', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const geradas = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(geradas.length, 1);
  assert.equal(geradas[0].valorTotalCentavos, 100000);
  const fatura = conn.faturas.get('5:2026-07');
  assert.equal(fatura.STATUS, 'prevista');
  assert.equal(fatura.VENCIMENTO, '2026-07-10');
  const itens = conn.faturaItens.filter((it) => it.FATURA_ID === fatura.ID);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].TIPO, 'recorrencia');
});

test('IDEMPOTÊNCIA (critério de aceite): rodar gerarFaturas duas vezes para a mesma competência não duplica', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const primeira = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(primeira.length, 1);
  const segunda = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(segunda.length, 0, 'a segunda passada não deveria gerar nada novo');
  assert.equal(conn.faturas.size, 1, 'não deveria ter nascido uma segunda fatura');
  assert.equal(conn.faturaItens.length, 1, 'não deveria ter nascido um segundo item');
});

test('tenant com inicio_cobranca futuro não gera fatura (critério de aceite)', async () => {
  const contratoFuturo = { ...CONTRATO_5, INICIO_COBRANCA: '2026-09-01' };
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: contratoFuturo } });
  const geradas = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(geradas.length, 0);
  assert.equal(conn.faturas.size, 0);
});

test('tenant sem contrato vigente não gera fatura', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: {} });
  const geradas = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(geradas.length, 0);
});

test('FATURA FECHADA NÃO MUDA DE VALOR (critério de aceite): alterar o contrato depois não afeta a fatura já gerada', async () => {
  const contratosPorTenant = { 5: CONTRATO_5 };
  const conn = conexao({ tenants: [5], contratosPorTenant });
  await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(conn.faturas.get('5:2026-07').VALOR_TOTAL_CENTAVOS, 100000);

  // "Contrato alterado depois" (equivalente a criarOuTrocarContrato mudando o
  // valor recorrente vigente) — a fatura de julho já foi gerada e congelada.
  contratosPorTenant[5] = { ...CONTRATO_5, VALOR_RECORRENTE_CENTAVOS: 999999 };
  await faturamento.gerarFaturas(conn, '2026-07'); // roda de novo — mesma competência

  assert.equal(conn.faturas.get('5:2026-07').VALOR_TOTAL_CENTAVOS, 100000, 'a fatura de julho já gerada não pode mudar');
  const itens = conn.faturaItens.filter((it) => it.FATURA_ID === conn.faturas.get('5:2026-07').ID);
  assert.equal(itens.length, 1, 'não deveria ter regravado nem duplicado itens');
});

// ===========================================================================
// Itens recorrentes do contrato
// ===========================================================================
test('gerarFaturas: soma os itens recorrentes do contrato (desconto reduz o total)', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    itensPorContrato: {
      10: [
        { ID: 1, TIPO: 'addon_ia', DESCRICAO: 'Add-on de IA', VALOR_UNITARIO_CENTAVOS: 5000, QUANTIDADE: 1 },
        { ID: 2, TIPO: 'desconto', DESCRICAO: 'Desconto fidelidade', VALOR_UNITARIO_CENTAVOS: -2000, QUANTIDADE: 1 },
      ],
    },
  });
  const [fatura] = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(fatura.valorTotalCentavos, 100000 + 5000 - 2000);
});

// ===========================================================================
// Excedente do consumo — custo desconhecido NUNCA vira zero silencioso.
// ===========================================================================
test('gerarFaturas: excedente do consumo medido vira item de fatura', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    consumoPorTenant: { '5:2026-07': [{ TIPO: 'ia_tokens', QUANTIDADE: 5000, CUSTO_CENTAVOS: 1250 }] },
  });
  const [fatura] = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(fatura.valorTotalCentavos, 100000 + 1250);
  assert.equal(fatura.custoIncerto, false);
  const item = conn.faturaItens.find((it) => it.TIPO === 'excedente');
  assert.ok(item, 'devia ter criado o item de excedente');
  assert.equal(item.VALOR_TOTAL_CENTAVOS, 1250);
});

test('CUSTO DESCONHECIDO NUNCA ASSUME ZERO: sinaliza custo_incerto quando há evento sem preço no período', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    consumoPorTenant: { '5:2026-07': [{ TIPO: 'ia_tokens', QUANTIDADE: 5000, CUSTO_CENTAVOS: 800 }] },
    custoDesconhecidoPorTenant: { '5:2026-07': 3 },
  });
  const [fatura] = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(fatura.custoIncerto, true, 'a fatura tem que ficar sinalizada para revisão');
  // O valor gerado é a soma do que É CONHECIDO — nunca inventado como zero.
  assert.equal(fatura.valorTotalCentavos, 100000 + 800);
  const faturaRow = conn.faturas.get('5:2026-07');
  assert.match(String(faturaRow.OBSERVACOES), /custo desconhecido/i);
});

test('sem consumo no período: não cria item de excedente e custo_incerto fica false', async () => {
  const conn = conexao({ tenants: [5], contratosPorTenant: { 5: CONTRATO_5 } });
  const [fatura] = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(fatura.custoIncerto, false);
  assert.ok(!conn.faturaItens.some((it) => it.TIPO === 'excedente'));
});

// ===========================================================================
// Parcela de implementação — cobra uma a mais por competência; a última
// absorve o resto da divisão (nunca perde centavo de arredondamento).
// ===========================================================================
test('implementação parcelada: cobra uma parcela por competência até completar; última absorve o resto', async () => {
  const conn = conexao({
    tenants: [5],
    contratosPorTenant: { 5: CONTRATO_5 },
    implementacaoPorTenant: { 5: { ID: 77, VALOR_CENTAVOS: 10000, FORMA_PAGAMENTO: 'parcelado', NUMERO_PARCELAS: 3 } },
  });
  const [f1] = await faturamento.gerarFaturas(conn, '2026-06');
  const [f2] = await faturamento.gerarFaturas(conn, '2026-07');
  const [f3] = await faturamento.gerarFaturas(conn, '2026-08');
  const [f4] = await faturamento.gerarFaturas(conn, '2026-09'); // já completou as 3 parcelas

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
  const [f1] = await faturamento.gerarFaturas(conn, '2026-06');
  const [f2] = await faturamento.gerarFaturas(conn, '2026-07');
  assert.equal(f1.valorTotalCentavos, 100000 + 200000);
  assert.equal(f2.valorTotalCentavos, 100000, 'segunda competência não cobra a implementação de novo');
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
  const geradas = await faturamento.gerarFaturas(conn, '2026-07');
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
