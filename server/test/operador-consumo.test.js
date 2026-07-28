// operador/consumo.js — GET /api/operador/tenants/:id/consumo (FIL-77): série
// de consumo por tipo, COM custo e tokens — é a exceção deliberada à regra
// "cliente nunca vê custo/tokens" (ver docs/SEGURANCA.md): só o operador.
// Mesmo padrão de teste de operador-tenants.test.js: comOperador roda via
// db.getConnection (duble), sem RLS de verdade.
'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const consumo = require('../operador/consumo');

function conexao({ tenantExiste = true, linhas = [], linhasMensal = [] } = {}) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      cap.push({ sql, binds });
      if (/SELECT id FROM tenant WHERE id = :id/i.test(sql)) {
        return { rows: tenantExiste ? [{ ID: binds.id }] : [] };
      }
      if (/FROM consumo_mensal/i.test(sql)) return { rows: linhasMensal };
      if (/FROM consumo_evento/i.test(sql)) return { rows: linhas };
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('consumoDoTenant: 404 se o tenant não existe', async () => {
  db.getConnection = async () => conexao({ tenantExiste: false });
  await assert.rejects(
    consumo.consumoDoTenant({ tenantId: 999 }),
    (err) => err.deOperador && err.status === 404
  );
});

test('consumoDoTenant: devolve série por tipo com custo e quantidade', async () => {
  const conn = conexao({
    linhas: [
      { TIPO: 'ia_tokens', QUANTIDADE: 15000, CUSTO_CENTAVOS: 340.5, EVENTOS: 12 },
      { TIPO: 'mensagem_enviada', QUANTIDADE: 87, CUSTO_CENTAVOS: 0, EVENTOS: 87 },
    ],
  });
  db.getConnection = async () => conn;
  const r = await consumo.consumoDoTenant({ tenantId: 5, de: '2026-07-01', ate: '2026-07-31' });
  assert.equal(r.tenantId, 5);
  assert.equal(r.serie.length, 2);
  assert.equal(r.serie[0].tipo, 'ia_tokens');
  assert.equal(r.serie[0].custoCentavos, 340.5);
  assert.equal(r.serie[0].quantidade, 15000);
  const consulta = conn.cap.find((c) => /FROM consumo_evento/i.test(c.sql));
  assert.equal(consulta.binds.tenantId, 5, 'filtra explicitamente pelo tenant pedido (cross-tenant de propósito, ver operador/db.js)');
});

test('consumoDoTenant: sem de/ate, usa o mês corrente como padrão', async () => {
  const conn = conexao({ linhas: [] });
  db.getConnection = async () => conn;
  const r = await consumo.consumoDoTenant({ tenantId: 5 });
  const inicioMesEsperado = `${new Date().toISOString().slice(0, 7)}-01`;
  assert.equal(r.de, inicioMesEsperado);
  assert.equal(r.ate, new Date().toISOString().slice(0, 10));
});

test('consumoDoTenant: rejeita data mal formatada', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    consumo.consumoDoTenant({ tenantId: 5, de: '01/07/2026' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('ACHADO DE REVIEW (P2): rejeita data de calendário IMPOSSÍVEL (regex sozinha aceitaria) — 400, não 500 do banco', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    consumo.consumoDoTenant({ tenantId: 5, de: '2026-02-31' }), // fevereiro não tem 31 dias
    (err) => err.deOperador && err.status === 400
  );
  await assert.rejects(
    consumo.consumoDoTenant({ tenantId: 5, ate: '2026-99-99' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('consumoDoTenant: rejeita "de" depois de "ate"', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    consumo.consumoDoTenant({ tenantId: 5, de: '2026-08-01', ate: '2026-07-01' }),
    (err) => err.deOperador && err.status === 400
  );
});

test('ACHADO DE REVIEW (P2): mês PASSADO vem de consumo_mensal (agregado permanente), mesmo com consumo_evento vazio (já purgado pela retenção)', async () => {
  const conn = conexao({
    linhas: [], // bruto já foi purgado pela retenção (consumo/fechamento.js)
    linhasMensal: [{ TIPO: 'ia_tokens', QUANTIDADE: 9000, CUSTO_CENTAVOS: 210 }],
  });
  db.getConnection = async () => conn;
  // Período totalmente no passado (bem antes do mês corrente).
  const r = await consumo.consumoDoTenant({ tenantId: 5, de: '2025-01-01', ate: '2025-01-31' });
  assert.equal(r.serie.length, 1);
  assert.equal(r.serie[0].tipo, 'ia_tokens');
  assert.equal(r.serie[0].quantidade, 9000, 'histórico não pode voltar vazio só porque o bruto já foi apagado');
  assert.equal(r.serie[0].custoCentavos, 210);
});

test('ACHADO DE REVIEW (P1): custo desconhecido (NULL) em QUALQUER uma das fontes contamina o total combinado — nunca vira número que pareça completo', async () => {
  const conn = conexao({
    linhas: [{ TIPO: 'ia_tokens', QUANTIDADE: 100, CUSTO_CENTAVOS: 50, EVENTOS: 3 }], // mês corrente, custo conhecido
    linhasMensal: [{ TIPO: 'ia_tokens', QUANTIDADE: 900, CUSTO_CENTAVOS: null }],      // mês passado, custo desconhecido
  });
  db.getConnection = async () => conn;
  const r = await consumo.consumoDoTenant({
    tenantId: 5,
    de: '2025-01-01',
    ate: `${new Date().toISOString().slice(0, 10)}`,
  });
  const linha = r.serie.find((s) => s.tipo === 'ia_tokens');
  assert.equal(linha.quantidade, 1000, 'quantidade sempre soma (nunca é incerta)');
  assert.equal(linha.custoCentavos, null, 'custo combinado tem que ficar NULO — não pode aparentar estar completo');
});
