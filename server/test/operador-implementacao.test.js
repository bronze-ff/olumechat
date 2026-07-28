'use strict';
// operador/implementacao.js — projeto de entrada do cliente (FIL-76). Mesmo
// padrão de teste de operador-contrato.test.js: comOperador roda tudo via
// db.getConnection (duble), sem RLS de verdade.
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const implementacao = require('../operador/implementacao');

const OPERADOR = { id: 1, email: 'op@falatta.com' };

const DADOS_VALIDOS = { valorCentavos: 200000, formaPagamento: 'a_vista', responsavel: 'Ana' };

function conexao({ tenantExiste = true, existente = null } = {}) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      cap.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), binds });
      const s = cap[cap.length - 1].sql;
      if (/^SELECT id FROM tenant WHERE id = :id/i.test(s)) {
        return { rows: tenantExiste ? [{ ID: binds.id }] : [] };
      }
      if (/^SELECT \* FROM implementacao WHERE tenant_id = :tid ORDER BY criado_em/i.test(s)) {
        return { rows: existente ? [existente] : [] };
      }
      if (/^INSERT INTO implementacao/i.test(s)) {
        return {
          rows: [{
            ID: 701, TENANT_ID: binds.tenantId, VALOR_CENTAVOS: binds.valor, FORMA_PAGAMENTO: binds.forma,
            NUMERO_PARCELAS: binds.parcelas, STATUS: binds.status, DATA_PREVISTA: binds.dataPrevista,
            DATA_ENTREGA: binds.dataEntrega, RESPONSAVEL: binds.responsavel, CRIADO_POR: binds.criadoPor,
            CRIADO_EM: new Date(), ATUALIZADO_EM: new Date(),
          }],
        };
      }
      if (/^SELECT \* FROM implementacao WHERE id = :id AND tenant_id = :tid/i.test(s)) {
        return { rows: existente ? [existente] : [] };
      }
      if (/^UPDATE implementacao SET/i.test(s)) {
        return {
          rows: [{
            ID: binds.id, TENANT_ID: binds.tid, VALOR_CENTAVOS: binds.valor, FORMA_PAGAMENTO: binds.forma,
            NUMERO_PARCELAS: binds.parcelas, STATUS: binds.status, DATA_PREVISTA: binds.dataPrevista,
            DATA_ENTREGA: binds.dataEntrega, RESPONSAVEL: binds.responsavel, ATUALIZADO_EM: new Date(),
          }],
        };
      }
      if (/^INSERT INTO operador_auditoria/i.test(s)) {
        return { rowsAffected: 1, rows: [] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function auditoriaRegistrada(conn) {
  return conn.cap.filter((c) => /^INSERT INTO operador_auditoria/i.test(c.sql));
}

test('criarImplementacao: 404 se o tenant não existe', async () => {
  db.getConnection = async () => conexao({ tenantExiste: false });
  await assert.rejects(
    implementacao.criarImplementacao({ operador: OPERADOR, tenantId: 999, dados: DADOS_VALIDOS }),
    (err) => err.deOperador && err.status === 404
  );
});

test('criarImplementacao rejeita valor decimal (nunca float)', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    implementacao.criarImplementacao({ operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, valorCentavos: 999.99 } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('criarImplementacao exige numeroParcelas >= 2 quando parcelado', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    implementacao.criarImplementacao({
      operador: OPERADOR, tenantId: 5, dados: { valorCentavos: 300000, formaPagamento: 'parcelado', numeroParcelas: 1 },
    }),
    (err) => err.deOperador && err.status === 400
  );
});

test('criarImplementacao rejeita numeroParcelas quando à vista (exceto 1)', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    implementacao.criarImplementacao({
      operador: OPERADOR, tenantId: 5, dados: { valorCentavos: 300000, formaPagamento: 'a_vista', numeroParcelas: 3 },
    }),
    (err) => err.deOperador && err.status === 400
  );
});

test('criarImplementacao: status "entregue" exige data de entrega', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    implementacao.criarImplementacao({
      operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, status: 'entregue' },
    }),
    (err) => err.deOperador && err.status === 400
  );
});

test('criarImplementacao: grava e audita (antes=null/depois={...})', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await implementacao.criarImplementacao({
    operador: OPERADOR, tenantId: 5, dados: { valorCentavos: 500000, formaPagamento: 'parcelado', numeroParcelas: 5, responsavel: 'Ana' },
  });
  assert.equal(r.valorCentavos, 500000);
  assert.ok(Number.isInteger(r.valorCentavos));
  assert.equal(r.status, 'a_iniciar', 'status padrão quando não informado');
  const aud = auditoriaRegistrada(conn);
  assert.equal(aud.length, 1);
  const detalhe = JSON.parse(aud[0].binds.det);
  assert.equal(detalhe.antes, null);
  assert.equal(detalhe.depois.numeroParcelas, 5);
});

test('obterImplementacao: sem nenhuma ainda cadastrada devolve null', async () => {
  db.getConnection = async () => conexao({ existente: null });
  assert.equal(await implementacao.obterImplementacao(5), null);
});

test('obterImplementacao: 404 se o tenant não existe', async () => {
  db.getConnection = async () => conexao({ tenantExiste: false });
  await assert.rejects(implementacao.obterImplementacao(999), (err) => err.deOperador && err.status === 404);
});

const EXISTENTE = {
  ID: 40, TENANT_ID: 5, VALOR_CENTAVOS: 400000, FORMA_PAGAMENTO: 'a_vista', NUMERO_PARCELAS: null,
  STATUS: 'em_andamento', DATA_PREVISTA: '2026-08-15', DATA_ENTREGA: null, RESPONSAVEL: 'Ana',
};

test('atualizarImplementacao: 404 se a implementação não pertence ao tenant', async () => {
  db.getConnection = async () => conexao({ existente: null });
  await assert.rejects(
    implementacao.atualizarImplementacao({ operador: OPERADOR, tenantId: 5, implementacaoId: 999, dados: { status: 'entregue' } }),
    (err) => err.deOperador && err.status === 404
  );
});

test('atualizarImplementacao: update parcial preserva campos não enviados (faz merge com o valor atual)', async () => {
  const conn = conexao({ existente: EXISTENTE });
  db.getConnection = async () => conn;
  const r = await implementacao.atualizarImplementacao({
    operador: OPERADOR, tenantId: 5, implementacaoId: 40, dados: { status: 'entregue', dataEntrega: '2026-08-20' },
  });
  assert.equal(r.status, 'entregue');
  const upd = conn.cap.find((c) => /^UPDATE implementacao SET/i.test(c.sql));
  assert.equal(upd.binds.valor, 400000, 'valor não enviado no PATCH permanece o mesmo');
  assert.equal(upd.binds.forma, 'a_vista', 'forma de pagamento não enviada permanece a mesma');
  assert.equal(upd.binds.responsavel, 'Ana', 'responsável não enviado permanece o mesmo');
});

test('atualizarImplementacao: rejeita mudar para "entregue" sem informar data de entrega (nem já ter uma)', async () => {
  const conn = conexao({ existente: { ...EXISTENTE, DATA_ENTREGA: null } });
  db.getConnection = async () => conn;
  await assert.rejects(
    implementacao.atualizarImplementacao({ operador: OPERADOR, tenantId: 5, implementacaoId: 40, dados: { status: 'entregue' } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('atualizarImplementacao: audita antes/depois com os valores reais', async () => {
  const conn = conexao({ existente: EXISTENTE });
  db.getConnection = async () => conn;
  await implementacao.atualizarImplementacao({
    operador: OPERADOR, tenantId: 5, implementacaoId: 40, dados: { valorCentavos: 450000 },
  });
  const aud = auditoriaRegistrada(conn);
  const detalhe = JSON.parse(aud[0].binds.det);
  assert.equal(detalhe.antes.valorCentavos, 400000, 'guarda o valor de ANTES da mudança');
  assert.equal(detalhe.depois.valorCentavos, 450000);
});
