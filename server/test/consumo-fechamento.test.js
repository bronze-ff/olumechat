// consumo/fechamento.js — fechamento mensal idempotente + retenção do bruto
// (FIL-77). fecharMes/limparEventosAntigos são puras/injetáveis (recebem a
// conexão já aberta) — testadas aqui sem banco nem rede.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fechamento = require('../consumo/fechamento');
const { tentarGlobal } = require('../workers/leaderLock');

/** Simula consumo_evento (linhas fixas) + consumo_mensal (mapa mutável, para
 *  provar a idempotência de verdade: rodar fecharMes duas vezes não deveria
 *  mudar o estado final nem duplicar linha). */
function conexao({ eventosAgrupados = [], mesesPendentes = [] } = {}) {
  const mensal = new Map(); // `${tenantId}:${anoMes}:${tipo}` -> linha
  const cap = [];
  return {
    cap, mensal,
    async execute(sql, binds = {}) {
      cap.push({ sql, binds });
      if (/SELECT DISTINCT to_char\(criado_em, 'YYYY-MM'\) AS ano_mes FROM consumo_evento/i.test(sql)) {
        return { rows: mesesPendentes.map((anoMes) => ({ ANO_MES: anoMes })) };
      }
      if (/SELECT tenant_id, tipo,[\s\S]*FROM consumo_evento/i.test(sql)) {
        return { rows: eventosAgrupados };
      }
      if (/INSERT INTO consumo_mensal/i.test(sql)) {
        const chave = `${binds.tenantId}:${binds.anoMes}:${binds.tipo}`;
        mensal.set(chave, {
          TENANT_ID: binds.tenantId, ANO_MES: binds.anoMes, TIPO: binds.tipo,
          QUANTIDADE: binds.qtd, CUSTO_CENTAVOS: binds.custo, CUSTO_INCOMPLETO: binds.custoIncompleto,
        });
        return { rows: [] };
      }
      if (/DELETE FROM consumo_evento/i.test(sql)) {
        return { rowsAffected: 3 };
      }
      return { rows: [], rowsAffected: 0 };
    },
  };
}

test('fecharMes: agrega por tenant_id+tipo e faz upsert em consumo_mensal', async () => {
  const conn = conexao({
    eventosAgrupados: [
      { TENANT_ID: 1, TIPO: 'ia_tokens', QUANTIDADE: 300, CUSTO_CENTAVOS: 12.5 },
      { TENANT_ID: 1, TIPO: 'mensagem_enviada', QUANTIDADE: 40, CUSTO_CENTAVOS: 0 },
      { TENANT_ID: 2, TIPO: 'ia_tokens', QUANTIDADE: 100, CUSTO_CENTAVOS: 4 },
    ],
  });
  const n = await fechamento.fecharMes(conn, '2026-07');
  assert.equal(n, 3);
  assert.equal(conn.mensal.get('1:2026-07:ia_tokens').QUANTIDADE, 300);
  assert.equal(conn.mensal.get('1:2026-07:mensagem_enviada').QUANTIDADE, 40);
  assert.equal(conn.mensal.get('2:2026-07:ia_tokens').CUSTO_CENTAVOS, 4);
});

test('IDEMPOTÊNCIA (critério de aceite do ticket): rodar fecharMes duas vezes não duplica nem soma em dobro', async () => {
  const conn = conexao({
    eventosAgrupados: [{ TENANT_ID: 5, TIPO: 'ia_tokens', QUANTIDADE: 900, CUSTO_CENTAVOS: 33 }],
  });
  await fechamento.fecharMes(conn, '2026-07');
  const depoisDaPrimeira = conn.mensal.get('5:2026-07:ia_tokens').QUANTIDADE;

  await fechamento.fecharMes(conn, '2026-07'); // roda de novo, mesmo mês
  const depoisDaSegunda = conn.mensal.get('5:2026-07:ia_tokens').QUANTIDADE;

  assert.equal(depoisDaSegunda, depoisDaPrimeira, 'rodar 2x não deveria mudar o agregado');
  assert.equal(conn.mensal.size, 1, 'não deveria ter nascido uma segunda linha');
  const upserts = conn.cap.filter((c) => /INSERT INTO consumo_mensal/i.test(c.sql));
  assert.equal(upserts.length, 2, 'duas tentativas de upsert, mas o resultado final é o mesmo (ON CONFLICT)');
  for (const u of upserts) assert.match(u.sql, /ON CONFLICT \(tenant_id, ano_mes, tipo\) DO UPDATE/i);
});

test('limparEventosAntigos: só apaga eventos com fechamento correspondente em consumo_mensal (EXISTS)', async () => {
  const conn = conexao();
  const apagados = await fechamento.limparEventosAntigos(conn, 90);
  assert.equal(apagados, 3);
  const del = conn.cap.find((c) => /DELETE FROM consumo_evento/i.test(c.sql));
  assert.ok(del, 'não rodou o DELETE');
  assert.match(del.sql, /EXISTS[\s\S]*consumo_mensal/i, 'precisa checar que o mês já foi fechado antes de apagar');
  assert.equal(del.binds.dias, 90);
});

test('limparEventosAntigos: usa o teto de retenção padrão de 90 dias quando não informado', async () => {
  const conn = conexao();
  await fechamento.limparEventosAntigos(conn);
  const del = conn.cap.find((c) => /DELETE FROM consumo_evento/i.test(c.sql));
  assert.equal(del.binds.dias, 90);
});

// ===========================================================================
// Achado de review (FIL-76): custo NULL (preço ainda não cadastrado) não pode
// virar zero PERMANENTE no agregado — precisa ficar marcado como incompleto.
// ===========================================================================
test('fecharMes: evento com custo desconhecido (NULL) marca o agregado como custo_incompleto, sem inventar valor', async () => {
  const conn = conexao({
    eventosAgrupados: [
      { TENANT_ID: 1, TIPO: 'ia_tokens', QUANTIDADE: 500, CUSTO_CENTAVOS: 20, CUSTO_INCOMPLETO: true },
    ],
  });
  await fechamento.fecharMes(conn, '2026-07');
  const linha = conn.mensal.get('1:2026-07:ia_tokens');
  assert.equal(linha.CUSTO_CENTAVOS, 20, 'soma só o que é conhecido — não inventa nem zera o que se sabe');
  assert.equal(linha.CUSTO_INCOMPLETO, true, 'marca que este agregado NÃO reflete o custo total real');
});

test('fecharMes: quando todos os eventos têm custo conhecido, custo_incompleto fica false', async () => {
  const conn = conexao({
    eventosAgrupados: [{ TENANT_ID: 1, TIPO: 'ia_tokens', QUANTIDADE: 300, CUSTO_CENTAVOS: 12.5, CUSTO_INCOMPLETO: false }],
  });
  await fechamento.fecharMes(conn, '2026-07');
  assert.equal(conn.mensal.get('1:2026-07:ia_tokens').CUSTO_INCOMPLETO, false);
});

// ===========================================================================
// Achado de review (FIL-76): recuperação fechava só o mês corrente + o
// anterior — uma competência mais antiga pendente (worker fora do ar por
// mais de um mês) nunca era fechada.
// ===========================================================================
test('fecharPendentes: descobre e fecha TODAS as competências com evento pendente, não só as 2 mais recentes', async () => {
  const conn = conexao({ mesesPendentes: ['2026-04', '2026-05', '2026-07'], eventosAgrupados: [{ TENANT_ID: 9, TIPO: 'mensagem_enviada', QUANTIDADE: 10, CUSTO_CENTAVOS: 0, CUSTO_INCOMPLETO: false }] });
  await fechamento.fecharPendentes(conn);
  const fechados = conn.cap.filter((c) => /INSERT INTO consumo_mensal/i.test(c.sql)).map((c) => c.binds.anoMes);
  assert.deepEqual(fechados, ['2026-04', '2026-05', '2026-07'], 'fecha TODAS as competências pendentes, mesmo uma antiga isolada (2026-04)');
  assert.ok(conn.cap.some((c) => /DELETE FROM consumo_evento/i.test(c.sql)), 'aplica a retenção depois de fechar tudo');
});

test('mesesComEventosPendentes: sem nenhum evento bruto, não fecha nada', async () => {
  const conn = conexao({ mesesPendentes: [] });
  const meses = await fechamento.mesesComEventosPendentes(conn);
  assert.deepEqual(meses, []);
});

test('anoMesDe / mesAnteriorDe: competência em UTC, formato YYYY-MM', () => {
  assert.equal(fechamento.anoMesDe(new Date(Date.UTC(2026, 6, 15))), '2026-07');
  assert.equal(fechamento.mesAnteriorDe(new Date(Date.UTC(2026, 6, 15))), '2026-06');
  assert.equal(fechamento.mesAnteriorDe(new Date(Date.UTC(2026, 0, 15))), '2025-12', 'virada de ano');
});

test('tentarGlobal (leaderLock): duas instâncias — só uma adquire o lock por tick', async () => {
  let concedidos = 0;
  const conn = { async execute() { concedidos++; return { rows: [{ ADQUIRIDO: concedidos === 1 }] }; } };
  assert.equal(await tentarGlobal(conn, 'consumo'), true, 'a primeira deveria adquirir');
  assert.equal(await tentarGlobal(conn, 'consumo'), false, 'a segunda deveria perder o lock');
});
