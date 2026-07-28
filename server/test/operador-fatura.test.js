'use strict';
// operador/fatura.js — CRUD de fatura/pagamento/inadimplência (FIL-79). Mesmo
// padrão de teste de operador-contrato.test.js: comOperador roda tudo via
// db.getConnection (duble), sem RLS de verdade.
process.env.META_APP_SECRET = 'x'; process.env.WEBHOOK_VERIFY_TOKEN = 'x'; process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = 'x'; process.env.WA_BUSINESS_ACCOUNT_ID = 'x'; process.env.JWT_SECRET = 'seg-teste-32-chars-abcdefghijk';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const fatura = require('../operador/fatura');

const OPERADOR = { id: 1, email: 'op@falatta.com' };

function conexao({ tenantExiste = true, fatura: faturaFixture = null, itens = [], pagamentos = [] } = {}) {
  const cap = [];
  const state = {
    fatura: faturaFixture ? { ...faturaFixture } : null,
    itens: itens.map((i) => ({ ...i })),
    pagamentos: pagamentos.map((p) => ({ ...p })),
    nextItemId: 9001,
    nextPagamentoId: 5001,
  };
  return {
    cap, state,
    async execute(sql, binds = {}) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      cap.push({ sql: s, binds });

      if (/^SELECT id FROM tenant WHERE id = :id/i.test(s)) {
        return { rows: tenantExiste ? [{ ID: binds.id }] : [] };
      }
      if (/^SELECT \* FROM fatura WHERE id = :id AND tenant_id = :tid/i.test(s)) {
        return { rows: state.fatura ? [state.fatura] : [] };
      }
      if (/^SELECT \* FROM fatura WHERE tenant_id = :tid ORDER BY competencia/i.test(s)) {
        return { rows: state.fatura ? [state.fatura] : [] };
      }
      if (/^SELECT \* FROM fatura_item WHERE fatura_id = :id ORDER BY criado_em/i.test(s)) {
        return { rows: state.itens };
      }
      if (/^SELECT \* FROM pagamento WHERE fatura_id = :id ORDER BY data_pagamento/i.test(s)) {
        return { rows: state.pagamentos };
      }
      if (/^SELECT COALESCE\(SUM\(valor_total_centavos\), 0\) AS total FROM fatura_item/i.test(s)) {
        const total = state.itens.reduce((acc, it) => acc + Number(it.VALOR_TOTAL_CENTAVOS), 0);
        return { rows: [{ TOTAL: total }] };
      }
      if (/^UPDATE fatura SET valor_total_centavos = :total/i.test(s)) {
        state.fatura.VALOR_TOTAL_CENTAVOS = binds.total;
        return { rows: [] };
      }
      if (/^SELECT COALESCE\(SUM\(valor_centavos\), 0\) AS pago FROM pagamento/i.test(s)) {
        const pago = state.pagamentos.reduce((acc, p) => acc + Number(p.VALOR_CENTAVOS), 0);
        return { rows: [{ PAGO: pago }] };
      }
      if (/^SELECT \* FROM fatura_item WHERE id = :id AND fatura_id = :fid/i.test(s)) {
        const item = state.itens.find((it) => it.ID === binds.id);
        return { rows: item ? [item] : [] };
      }
      if (/^INSERT INTO fatura_item/i.test(s)) {
        const item = {
          ID: state.nextItemId++, FATURA_ID: binds.faturaId, TIPO: binds.tipo, DESCRICAO: binds.descricao,
          QUANTIDADE: binds.quantidade, VALOR_UNITARIO_CENTAVOS: binds.valorUnitario, VALOR_TOTAL_CENTAVOS: binds.valorTotal,
        };
        state.itens.push(item);
        return { rows: [item] };
      }
      if (/^DELETE FROM fatura_item WHERE id = :id AND fatura_id = :fid/i.test(s)) {
        state.itens = state.itens.filter((it) => it.ID !== binds.id);
        return { rowsAffected: 1, rows: [] };
      }
      if (/^UPDATE fatura SET status = 'emitida'/i.test(s)) {
        state.fatura.STATUS = 'emitida'; state.fatura.EMITIDA_EM = new Date();
        return { rows: [state.fatura] };
      }
      if (/^UPDATE fatura SET status = 'cancelada'/i.test(s)) {
        state.fatura.STATUS = 'cancelada';
        return { rows: [state.fatura] };
      }
      if (/^UPDATE fatura SET status = 'em_negociacao'/i.test(s)) {
        state.fatura.STATUS = 'em_negociacao';
        return { rows: [state.fatura] };
      }
      if (/^SELECT COUNT\(\*\) AS cnt FROM pagamento WHERE fatura_id = :id/i.test(s)) {
        return { rows: [{ CNT: state.pagamentos.length }] };
      }
      if (/^INSERT INTO pagamento/i.test(s)) {
        const p = {
          ID: state.nextPagamentoId++, FATURA_ID: binds.faturaId, VALOR_CENTAVOS: binds.valor,
          DATA_PAGAMENTO: binds.data, MEIO: binds.meio, COMPROVANTE: binds.comprovante, REGISTRADO_POR: binds.registradoPor,
        };
        state.pagamentos.push(p);
        return { rows: [p] };
      }
      if (/^UPDATE fatura SET status = 'paga'/i.test(s)) {
        state.fatura.STATUS = 'paga'; state.fatura.PAGA_EM = new Date();
        return { rows: [] };
      }
      if (/^INSERT INTO operador_auditoria/i.test(s)) {
        return { rowsAffected: 1, rows: [] };
      }
      if (/FROM fatura f\s+JOIN tenant t/i.test(s)) {
        return {
          rows: state.fatura
            ? [{ ...state.fatura, TENANT_NOME: 'Cliente X', TENANT_SLUG: 'cliente-x', TENANT_STATUS: 'ativo', DIAS_VENCIDA: 10 }]
            : [],
        };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function auditoriaRegistrada(conn) {
  return conn.cap.filter((c) => /^INSERT INTO operador_auditoria/i.test(c.sql));
}

const FATURA_PREVISTA = {
  ID: 100, TENANT_ID: 5, COMPETENCIA: '2026-07', VENCIMENTO: '2026-07-10',
  VALOR_TOTAL_CENTAVOS: 100000, STATUS: 'prevista', CUSTO_INCERTO: false,
  EMITIDA_EM: null, PAGA_EM: null, OBSERVACOES: null,
};

// ===========================================================================
// Consulta + escopo de tenant
// ===========================================================================
test('listarFaturas: 404 se o tenant não existe', async () => {
  db.getConnection = async () => conexao({ tenantExiste: false });
  await assert.rejects(fatura.listarFaturas(999), (err) => err.deOperador && err.status === 404);
});

test('obterFatura: 404 se a fatura não pertence ao tenant', async () => {
  db.getConnection = async () => conexao({ fatura: null });
  await assert.rejects(
    fatura.obterFatura({ tenantId: 5, faturaId: 100 }),
    (err) => err.deOperador && err.status === 404
  );
});

test('obterFatura: devolve itens, pagamentos e saldo calculado', async () => {
  const conn = conexao({
    fatura: FATURA_PREVISTA,
    itens: [{ ID: 1, VALOR_TOTAL_CENTAVOS: 100000 }],
    pagamentos: [{ ID: 1, VALOR_CENTAVOS: 40000 }],
  });
  db.getConnection = async () => conn;
  const r = await fatura.obterFatura({ tenantId: 5, faturaId: 100 });
  assert.equal(r.itens.length, 1);
  assert.equal(r.pagamentos.length, 1);
  assert.equal(r.saldoCentavos, 60000);
});

// ===========================================================================
// Itens manuais — só enquanto a fatura é `prevista` (fatura emitida é congelada).
// ===========================================================================
test('adicionarItem: fatura já emitida rejeita a mutação (409) — itens são histórico congelado', async () => {
  db.getConnection = async () => conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'emitida' } });
  await assert.rejects(
    fatura.adicionarItem({ operador: OPERADOR, tenantId: 5, faturaId: 100, dados: { tipo: 'avulso', descricao: 'x', valorUnitarioCentavos: 100 } }),
    (err) => err.deOperador && err.status === 409
  );
});

test('adicionarItem rejeita tipo fora da allowlist', async () => {
  db.getConnection = async () => conexao({ fatura: FATURA_PREVISTA });
  await assert.rejects(
    fatura.adicionarItem({ operador: OPERADOR, tenantId: 5, faturaId: 100, dados: { tipo: 'excedente', descricao: 'x', valorUnitarioCentavos: 100 } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('adicionarItem: item avulso soma ao total da fatura', async () => {
  const conn = conexao({ fatura: FATURA_PREVISTA, itens: [{ ID: 1, VALOR_TOTAL_CENTAVOS: 100000 }] });
  db.getConnection = async () => conn;
  const r = await fatura.adicionarItem({
    operador: OPERADOR, tenantId: 5, faturaId: 100,
    dados: { tipo: 'avulso', descricao: 'Consultoria extra', valorUnitarioCentavos: 5000 },
  });
  assert.equal(r.valorTotalCentavos, 5000);
  assert.equal(conn.state.fatura.VALOR_TOTAL_CENTAVOS, 105000, 'o total da fatura tem que refletir o novo item');
  const aud = auditoriaRegistrada(conn);
  assert.equal(aud.length, 1);
});

test('adicionarItem: desconto com valor positivo é rejeitado', async () => {
  db.getConnection = async () => conexao({ fatura: FATURA_PREVISTA });
  await assert.rejects(
    fatura.adicionarItem({ operador: OPERADOR, tenantId: 5, faturaId: 100, dados: { tipo: 'desconto', descricao: 'x', valorUnitarioCentavos: 500 } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('removerItem: recalcula o total da fatura após remover', async () => {
  const conn = conexao({
    fatura: FATURA_PREVISTA,
    itens: [{ ID: 1, VALOR_TOTAL_CENTAVOS: 100000 }, { ID: 2, VALOR_TOTAL_CENTAVOS: 5000 }],
  });
  db.getConnection = async () => conn;
  await fatura.removerItem({ operador: OPERADOR, tenantId: 5, faturaId: 100, itemId: 2 });
  assert.equal(conn.state.fatura.VALOR_TOTAL_CENTAVOS, 100000);
});

test('removerItem: 404 se o item não existe na fatura', async () => {
  db.getConnection = async () => conexao({ fatura: FATURA_PREVISTA, itens: [] });
  await assert.rejects(
    fatura.removerItem({ operador: OPERADOR, tenantId: 5, faturaId: 100, itemId: 999 }),
    (err) => err.deOperador && err.status === 404
  );
});

// ===========================================================================
// Ciclo de vida
// ===========================================================================
test('emitirFatura: prevista -> emitida', async () => {
  const conn = conexao({ fatura: FATURA_PREVISTA });
  db.getConnection = async () => conn;
  const r = await fatura.emitirFatura({ operador: OPERADOR, tenantId: 5, faturaId: 100 });
  assert.equal(r.status, 'emitida');
  const aud = auditoriaRegistrada(conn);
  assert.equal(aud.length, 1);
});

test('emitirFatura: 409 se a fatura não está prevista', async () => {
  db.getConnection = async () => conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'emitida' } });
  await assert.rejects(
    fatura.emitirFatura({ operador: OPERADOR, tenantId: 5, faturaId: 100 }),
    (err) => err.deOperador && err.status === 409
  );
});

test('cancelarFatura: 409 se já está paga', async () => {
  db.getConnection = async () => conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'paga' } });
  await assert.rejects(
    fatura.cancelarFatura({ operador: OPERADOR, tenantId: 5, faturaId: 100 }),
    (err) => err.deOperador && err.status === 409
  );
});

test('cancelarFatura: 409 se já tem pagamento registrado', async () => {
  db.getConnection = async () => conexao({
    fatura: { ...FATURA_PREVISTA, STATUS: 'emitida' },
    pagamentos: [{ ID: 1, VALOR_CENTAVOS: 1000 }],
  });
  await assert.rejects(
    fatura.cancelarFatura({ operador: OPERADOR, tenantId: 5, faturaId: 100 }),
    (err) => err.deOperador && err.status === 409
  );
});

test('cancelarFatura: sucesso quando prevista/emitida sem pagamento', async () => {
  const conn = conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'emitida' } });
  db.getConnection = async () => conn;
  const r = await fatura.cancelarFatura({ operador: OPERADOR, tenantId: 5, faturaId: 100, motivo: 'cliente cancelou o contrato' });
  assert.equal(r.status, 'cancelada');
});

test('marcarEmNegociacao: só a partir de emitida/atrasada', async () => {
  db.getConnection = async () => conexao({ fatura: FATURA_PREVISTA }); // prevista
  await assert.rejects(
    fatura.marcarEmNegociacao({ operador: OPERADOR, tenantId: 5, faturaId: 100 }),
    (err) => err.deOperador && err.status === 409
  );
});

test('marcarEmNegociacao: atrasada -> em_negociacao', async () => {
  const conn = conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'atrasada' } });
  db.getConnection = async () => conn;
  const r = await fatura.marcarEmNegociacao({ operador: OPERADOR, tenantId: 5, faturaId: 100, motivo: 'promessa de pagamento' });
  assert.equal(r.status, 'em_negociacao');
});

// ===========================================================================
// Pagamento — parcial mantém saldo aberto; total fecha (critério de aceite).
// ===========================================================================
test('CORRIDA DE SALDO (achado de review do PR #26): registrarPagamento trava a fatura com FOR UPDATE', async () => {
  const conn = conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'emitida', VALOR_TOTAL_CENTAVOS: 10000 } });
  db.getConnection = async () => conn;
  await fatura.registrarPagamento({
    operador: OPERADOR, tenantId: 5, faturaId: 100,
    dados: { valorCentavos: 4000, data: '2026-07-15', meio: 'pix' },
  });
  const leituraDaFatura = conn.cap.find((c) => /^SELECT \* FROM fatura WHERE id = :id AND tenant_id = :tid/i.test(c.sql));
  assert.ok(leituraDaFatura, 'deveria ter lido a fatura antes de gravar o pagamento');
  assert.match(leituraDaFatura.sql, /FOR UPDATE/i, 'sem o lock, dois pagamentos concorrentes podem somar mais que o total da fatura');
});

test('registrarPagamento: fatura ainda prevista (não emitida) rejeita pagamento (409)', async () => {
  db.getConnection = async () => conexao({ fatura: FATURA_PREVISTA });
  await assert.rejects(
    fatura.registrarPagamento({
      operador: OPERADOR, tenantId: 5, faturaId: 100,
      dados: { valorCentavos: 1000, data: '2026-07-15', meio: 'pix' },
    }),
    (err) => err.deOperador && err.status === 409
  );
});

test('registrarPagamento: rejeita meio de pagamento fora da allowlist', async () => {
  db.getConnection = async () => conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'emitida' } });
  await assert.rejects(
    fatura.registrarPagamento({
      operador: OPERADOR, tenantId: 5, faturaId: 100,
      dados: { valorCentavos: 1000, data: '2026-07-15', meio: 'dinheiro' },
    }),
    (err) => err.deOperador && err.status === 400
  );
});

test('registrarPagamento: rejeita valor maior que o saldo devido', async () => {
  db.getConnection = async () => conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'emitida', VALOR_TOTAL_CENTAVOS: 10000 } });
  await assert.rejects(
    fatura.registrarPagamento({
      operador: OPERADOR, tenantId: 5, faturaId: 100,
      dados: { valorCentavos: 20000, data: '2026-07-15', meio: 'pix' },
    }),
    (err) => err.deOperador && err.status === 400
  );
});

test('PAGAMENTO PARCIAL (critério de aceite): mantém a fatura aberta com saldo', async () => {
  const conn = conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'emitida', VALOR_TOTAL_CENTAVOS: 10000 } });
  db.getConnection = async () => conn;
  const r = await fatura.registrarPagamento({
    operador: OPERADOR, tenantId: 5, faturaId: 100,
    dados: { valorCentavos: 4000, data: '2026-07-15', meio: 'pix' },
  });
  assert.equal(r.saldoCentavos, 6000);
  assert.equal(r.status, 'emitida', 'pagamento parcial não fecha a fatura');
  assert.equal(conn.state.fatura.STATUS, 'emitida');
});

test('PAGAMENTO TOTAL (critério de aceite): fecha a fatura (status paga, paga_em setado)', async () => {
  const conn = conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'emitida', VALOR_TOTAL_CENTAVOS: 10000 } });
  db.getConnection = async () => conn;
  const r = await fatura.registrarPagamento({
    operador: OPERADOR, tenantId: 5, faturaId: 100,
    dados: { valorCentavos: 10000, data: '2026-07-15', meio: 'boleto' },
  });
  assert.equal(r.saldoCentavos, 0);
  assert.equal(r.status, 'paga');
  assert.equal(conn.state.fatura.STATUS, 'paga');
  assert.ok(conn.state.fatura.PAGA_EM);
});

test('PAGAMENTO EM DUAS VEZES: primeira parcial, segunda fecha exatamente no saldo restante', async () => {
  const conn = conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'atrasada', VALOR_TOTAL_CENTAVOS: 10000 } });
  db.getConnection = async () => conn;
  const r1 = await fatura.registrarPagamento({
    operador: OPERADOR, tenantId: 5, faturaId: 100,
    dados: { valorCentavos: 6000, data: '2026-07-15', meio: 'pix' },
  });
  assert.equal(r1.saldoCentavos, 4000);
  assert.equal(r1.status, 'atrasada');

  const r2 = await fatura.registrarPagamento({
    operador: OPERADOR, tenantId: 5, faturaId: 100,
    dados: { valorCentavos: 4000, data: '2026-07-20', meio: 'transferencia' },
  });
  assert.equal(r2.saldoCentavos, 0);
  assert.equal(r2.status, 'paga');
});

test('registrarPagamento: rejeita quando a fatura já está cancelada', async () => {
  db.getConnection = async () => conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'cancelada' } });
  await assert.rejects(
    fatura.registrarPagamento({
      operador: OPERADOR, tenantId: 5, faturaId: 100,
      dados: { valorCentavos: 100, data: '2026-07-15', meio: 'pix' },
    }),
    (err) => err.deOperador && err.status === 409
  );
});

// ===========================================================================
// Geração manual (dispara a mesma rotina de financeiro/faturamento.js sob demanda)
// ===========================================================================
test('gerarManual rejeita competência mal formatada', async () => {
  await assert.rejects(
    fatura.gerarManual({ operador: OPERADOR, competencia: '07-2026' }),
    (err) => err.deOperador && err.status === 400
  );
});

// ===========================================================================
// Inadimplência — a listagem SUGERE suspensão; nunca executa.
// ===========================================================================
test('listarInadimplencia: devolve as faturas atrasadas com sugestão de suspensão', async () => {
  const conn = conexao({ fatura: { ...FATURA_PREVISTA, STATUS: 'atrasada' } });
  db.getConnection = async () => conn;
  const r = await fatura.listarInadimplencia();
  assert.equal(r.length, 1);
  assert.equal(r[0].sugereSuspensao, true);
});

test('listarInadimplencia nunca chama a suspensão do tenant diretamente', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'operador', 'fatura.js'), 'utf8');
  assert.ok(!/alterarStatus|suspender/i.test(src), 'operador/fatura.js não pode suspender tenant — é sempre ação explícita do operador em outra rota');
});
