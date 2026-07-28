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

function conexao({ tenantExiste = true, linhas = [], retidoLinhas = [] } = {}) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      cap.push({ sql, binds });
      if (/SELECT id FROM tenant WHERE id = :id/i.test(sql)) {
        return { rows: tenantExiste ? [{ ID: binds.id }] : [] };
      }
      if (/FROM consumo_mensal/i.test(sql)) return { rows: retidoLinhas };
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
      { ANO_MES: '2026-07', TIPO: 'ia_tokens', QUANTIDADE: 15000, CUSTO_CENTAVOS: 340.5, CUSTO_INCOMPLETO: false, EVENTOS: 12 },
      { ANO_MES: '2026-07', TIPO: 'mensagem_enviada', QUANTIDADE: 87, CUSTO_CENTAVOS: 0, CUSTO_INCOMPLETO: false, EVENTOS: 87 },
    ],
  });
  db.getConnection = async () => conn;
  const r = await consumo.consumoDoTenant({ tenantId: 5, de: '2026-07-01', ate: '2026-07-31' });
  assert.equal(r.tenantId, 5);
  assert.equal(r.serie.length, 2);
  assert.equal(r.serie[0].tipo, 'ia_tokens');
  assert.equal(r.serie[0].custoCentavos, 340.5);
  assert.equal(r.serie[0].quantidade, 15000);
  assert.equal(r.retidoParcial, false, 'período todo coberto pelo bruto, nada veio do agregado retido');
  const consulta = conn.cap.find((c) => /FROM consumo_evento/i.test(c.sql));
  assert.equal(consulta.binds.tenantId, 5, 'filtra explicitamente pelo tenant pedido (cross-tenant de propósito, ver operador/db.js)');
});

// ===========================================================================
// Achado de review (FIL-76): range fora da janela de retenção do bruto (~90
// dias) tem que cair pro agregado mensal PERMANENTE, não voltar vazio.
// ===========================================================================
test('consumoDoTenant: mês já limpo pela retenção (sem bruto) cai pro agregado mensal retido', async () => {
  const conn = conexao({
    linhas: [], // bruto já foi apagado pela retenção
    retidoLinhas: [
      { ANO_MES: '2026-01', TIPO: 'ia_tokens', QUANTIDADE: 5000, CUSTO_CENTAVOS: 120, CUSTO_INCOMPLETO: false },
    ],
  });
  db.getConnection = async () => conn;
  const r = await consumo.consumoDoTenant({ tenantId: 5, de: '2026-01-01', ate: '2026-01-31' });
  assert.equal(r.serie.length, 1);
  assert.equal(r.serie[0].tipo, 'ia_tokens');
  assert.equal(r.serie[0].quantidade, 5000);
  assert.equal(r.serie[0].custoCentavos, 120);
  assert.equal(r.retidoParcial, true, 'avisa que este mês veio do agregado, sem precisão de dia');
});

test('consumoDoTenant: mês coberto pelo bruto NUNCA soma o agregado mensal do mesmo mês (evita dobrar a contagem)', async () => {
  const conn = conexao({
    linhas: [{ ANO_MES: '2026-07', TIPO: 'ia_tokens', QUANTIDADE: 1000, CUSTO_CENTAVOS: 50, CUSTO_INCOMPLETO: false, EVENTOS: 4 }],
    // Linha "fantasma" no agregado mensal do MESMO mês+tipo — não pode ser
    // somada, senão o total dobraria (o fechamento roda todo dia e reescreve
    // consumo_mensal mesmo pra meses cujo bruto ainda não foi limpo).
    retidoLinhas: [{ ANO_MES: '2026-07', TIPO: 'ia_tokens', QUANTIDADE: 1000, CUSTO_CENTAVOS: 50, CUSTO_INCOMPLETO: false }],
  });
  db.getConnection = async () => conn;
  const r = await consumo.consumoDoTenant({ tenantId: 5, de: '2026-07-01', ate: '2026-07-31' });
  assert.equal(r.serie.length, 1);
  assert.equal(r.serie[0].quantidade, 1000, 'não pode dobrar — o bruto já cobre este mês');
  assert.equal(r.serie[0].custoCentavos, 50);
  assert.equal(r.retidoParcial, false, 'este mês veio do bruto, não do agregado');
});

test('consumoDoTenant: range parcial — um mês do bruto, outro retido — mescla os dois sem duplicar', async () => {
  const conn = conexao({
    linhas: [{ ANO_MES: '2026-02', TIPO: 'ia_tokens', QUANTIDADE: 300, CUSTO_CENTAVOS: 10, CUSTO_INCOMPLETO: false, EVENTOS: 2 }],
    retidoLinhas: [{ ANO_MES: '2026-01', TIPO: 'ia_tokens', QUANTIDADE: 700, CUSTO_CENTAVOS: 25, CUSTO_INCOMPLETO: false }],
  });
  db.getConnection = async () => conn;
  const r = await consumo.consumoDoTenant({ tenantId: 5, de: '2026-01-01', ate: '2026-02-28' });
  assert.equal(r.serie.length, 1);
  assert.equal(r.serie[0].quantidade, 1000, 'soma os dois meses (janeiro do agregado + fevereiro do bruto)');
  assert.equal(r.serie[0].custoCentavos, 35);
  assert.equal(r.retidoParcial, true);
});

test('consumoDoTenant: custo_incompleto do agregado retido propaga pra série', async () => {
  const conn = conexao({
    linhas: [],
    retidoLinhas: [{ ANO_MES: '2026-01', TIPO: 'ia_tokens', QUANTIDADE: 100, CUSTO_CENTAVOS: 5, CUSTO_INCOMPLETO: true }],
  });
  db.getConnection = async () => conn;
  const r = await consumo.consumoDoTenant({ tenantId: 5, de: '2026-01-01', ate: '2026-01-31' });
  assert.equal(r.serie[0].custoIncompleto, true, 'o operador precisa saber que este número não é o custo total real');
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

test('consumoDoTenant: rejeita data de calendário impossível (2026-02-31)', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    consumo.consumoDoTenant({ tenantId: 5, de: '2026-02-31' }),
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
