// consumo/fechamento.js — fechamento mensal idempotente + retenção do bruto
// (FIL-77). fecharMes/limparEventosAntigos são puras/injetáveis (recebem a
// conexão já aberta) — testadas aqui sem banco nem rede.
'use strict';
process.env.META_APP_SECRET = 'x'; process.env.WEBHOOK_VERIFY_TOKEN = 'x'; process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = 'x'; process.env.WA_BUSINESS_ACCOUNT_ID = 'x'; process.env.JWT_SECRET = 'seg-teste-32-chars-abcdefghijk';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const fechamento = require('../consumo/fechamento');
const { tentarGlobal } = require('../workers/leaderLock');

/** Simula consumo_evento (linhas fixas) + consumo_mensal (mapa mutável, para
 *  provar a idempotência de verdade: rodar fecharMes duas vezes não deveria
 *  mudar o estado final nem duplicar linha). */
function conexao({ eventosAgrupados = [] } = {}) {
  const mensal = new Map(); // `${tenantId}:${anoMes}:${tipo}` -> linha
  const cap = [];
  return {
    cap, mensal,
    async execute(sql, binds = {}) {
      cap.push({ sql, binds });
      if (/SELECT tenant_id, tipo,[\s\S]*FROM consumo_evento/i.test(sql)) {
        return { rows: eventosAgrupados };
      }
      if (/INSERT INTO consumo_mensal/i.test(sql)) {
        const chave = `${binds.tenantId}:${binds.anoMes}:${binds.tipo}`;
        mensal.set(chave, { TENANT_ID: binds.tenantId, ANO_MES: binds.anoMes, TIPO: binds.tipo, QUANTIDADE: binds.qtd, CUSTO_CENTAVOS: binds.custo });
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

test('ACHADO DE REVIEW (P1): custo_centavos NULL (desconhecido) vindo do banco é PRESERVADO — nunca vira zero', async () => {
  // A query real usa bool_or(custo_centavos IS NULL) para decidir NULL vs.
  // SUM — aqui simulamos o RESULTADO que o Postgres devolveria para um grupo
  // com pelo menos 1 evento de custo desconhecido.
  const conn = conexao({
    eventosAgrupados: [
      { TENANT_ID: 9, TIPO: 'ia_tokens', QUANTIDADE: 500, CUSTO_CENTAVOS: null },
    ],
  });
  await fechamento.fecharMes(conn, '2026-07');
  const linha = conn.mensal.get('9:2026-07:ia_tokens');
  assert.equal(linha.QUANTIDADE, 500, 'quantidade continua conhecida mesmo com custo incerto');
  assert.equal(linha.CUSTO_CENTAVOS, null, 'custo desconhecido não pode virar 0 — perderia a incerteza pra sempre depois da retenção apagar o bruto');
  const upsert = conn.cap.find((c) => /INSERT INTO consumo_mensal/i.test(c.sql));
  assert.equal(upsert.binds.custo, null);
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

test('mesesComEventoBruto: descobre TODAS as competências distintas ainda presentes no bruto', async () => {
  const conn = {
    async execute(sql) {
      if (/SELECT DISTINCT to_char\(criado_em, 'YYYY-MM'\) AS ano_mes FROM consumo_evento/i.test(sql)) {
        return { rows: [{ ANO_MES: '2026-04' }, { ANO_MES: '2026-05' }, { ANO_MES: '2026-07' }] };
      }
      return { rows: [] };
    },
  };
  const meses = await fechamento.mesesComEventoBruto(conn);
  assert.deepEqual(meses, ['2026-04', '2026-05', '2026-07']);
});

test('ACHADO DE REVIEW (P1, mais grave da 2ª rodada): a retenção purga por COMPETÊNCIA INTEIRA — nunca por linha/dia isolado', async () => {
  // A versão anterior comparava `criado_em < now() - N dias` (linha a linha):
  // o corte entrava NO MEIO de um mês, esse mês continuava aparecendo em
  // mesesComEventoBruto() (ainda tinha ALGUM evento) e o tick seguinte
  // REAGREGAVA só o que sobrou, sobrescrevendo o total permanente já fechado
  // com uma soma cada vez menor — silenciosamente, a cada dia.
  //
  // A correção compara pelo MÊS (to_char(...,'YYYY-MM')) dos dois lados: uma
  // competência só é elegível quando o MÊS INTEIRO já passou do corte — nunca
  // uma linha isolada. Fixamos aqui a FORMA da query (não dá pra simular
  // now()/criado_em de verdade sem Postgres real — ver o teste de integração
  // gated por TEST_DATABASE_URL logo abaixo para a prova fim-a-fim).
  const conn = conexao();
  await fechamento.limparEventosAntigos(conn, 90);
  const del = conn.cap.find((c) => /DELETE FROM consumo_evento/i.test(c.sql));
  assert.ok(del, 'não rodou o DELETE');
  assert.match(
    del.sql,
    /to_char\(\s*e\.criado_em\s*,\s*'YYYY-MM'\s*\)\s*<\s*to_char\(\s*now\(\)\s*-\s*make_interval\(days\s*=>\s*:dias\)\s*,\s*'YYYY-MM'\s*\)/i,
    'a comparação precisa ser por MÊS dos dois lados (ano_mes < ano_mes do corte) — nunca `criado_em < now() - N dias` linha a linha'
  );
  assert.doesNotMatch(
    del.sql.replace(/to_char\([^)]*\)/gi, ''), // tira as duas chamadas to_char(...) e sobra só o resto da query
    /criado_em\s*<\s*now\(\)/i,
    'não pode sobrar uma comparação direta de criado_em < now() fora do to_char (isso reintroduziria a purga parcial)'
  );
});

test('ACHADO DE REVIEW (P1): fecharMes é chamado só com o que EXISTE no bruto — a garantia de nunca-parcial vem inteira de limparEventosAntigos nunca deixar um mês pela metade', async () => {
  // Continuação do teste acima: mesmo que fecharMes seja re-executado várias
  // vezes para o MESMO mês (tick() roda todo dia enquanto o mês ainda tem
  // QUALQUER evento bruto), o total só muda se o CONJUNTO de eventos daquele
  // mês mudar — e a promessa da retenção atômica é que esse conjunto nunca
  // encolhe pela metade: ou continua 100% presente, ou vira 100% ausente
  // (mês some de mesesComEventoBruto, fecharMes nunca mais roda pra ele).
  const eventosCompletos = [
    { TENANT_ID: 1, TIPO: 'ia_tokens', QUANTIDADE: 3000, CUSTO_CENTAVOS: 150 },
  ];
  const conn = conexao({ eventosAgrupados: eventosCompletos });

  // Tick 1: mês fechado com o conjunto completo.
  await fechamento.fecharMes(conn, '2026-01');
  assert.equal(conn.mensal.get('1:2026-01:ia_tokens').QUANTIDADE, 3000);

  // Tick 2..N: enquanto o mês ainda aparece em mesesComEventoBruto (retenção
  // não removeu por atomicidade), o CONJUNTO de linhas continua o MESMO —
  // reagregar de novo tem que dar o MESMO resultado (idempotência real,
  // não só "não duplica linha").
  await fechamento.fecharMes(conn, '2026-01');
  await fechamento.fecharMes(conn, '2026-01');
  assert.equal(conn.mensal.get('1:2026-01:ia_tokens').QUANTIDADE, 3000, 'o total não pode ter encolhido só de reprocessar o mesmo mês');
});

// ---------------------------------------------------------------------------
// INTEGRAÇÃO — Postgres real, migrações 001..016 aplicadas. Prova fim-a-fim
// que a retenção atômica por mês não corrói o total já fechado, mesmo com
// eventos de timestamps reais straddling o corte de 90 dias. Roda só com
// TEST_DATABASE_URL; sem ela é PULADO (mesmo padrão de test/db-tenant.test.js).
// ---------------------------------------------------------------------------
const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;
const semBanco = !URL_INTEGRACAO;

test('RLS real: retenção NÃO reescreve o total permanente quando o corte de 90 dias cai NO MEIO do mês',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real, migrações 001-016 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `r${Date.now()}`;
    try {
      const t = await admin.query(`INSERT INTO tenant (nome, slug) VALUES ('R ${marca}', 'r-${marca}') RETURNING id`);
      const tenantId = t.rows[0].id;

      // Um mês inteiro de eventos, com datas REAIS espalhadas pelos 30 dias —
      // metade cai antes do corte de 90 dias, metade depois. Sem a correção,
      // isso é EXATAMENTE o cenário que corrompia o total.
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(tenantId)]);
      for (let dia = 1; dia <= 30; dia++) {
        // Datas fixas e antigas o bastante para o mês INTEIRO já ter cruzado
        // qualquer corte de retenção razoável (dias=90) na data de hoje.
        await admin.query(
          `INSERT INTO consumo_evento (tenant_id, tipo, quantidade, custo_centavos, criado_em)
           VALUES ($1, 'ia_tokens', 100, 5, (now() - interval '200 days') + make_interval(days => $2))`,
          [tenantId, dia]
        );
      }
      await admin.query('COMMIT');

      const fechamentoReal = require('../consumo/fechamento');
      const wrapAdmin = require('../db/pool')._wrapClient({ query: (...a) => admin.query(...a), release: () => {} });
      const anoMes = await admin.query(
        `SELECT to_char(criado_em, 'YYYY-MM') AS ano_mes FROM consumo_evento WHERE tenant_id = $1 LIMIT 1`, [tenantId]
      ).then((r) => r.rows[0].ano_mes);

      // Tick 1: fecha o mês inteiro.
      await fechamentoReal.fecharMes(wrapAdmin, anoMes);
      const antes = await admin.query(
        `SELECT quantidade, custo_centavos FROM consumo_mensal WHERE tenant_id = $1 AND ano_mes = $2`, [tenantId, anoMes]
      );
      assert.equal(Number(antes.rows[0].quantidade), 3000, '30 dias × 100 = 3000');

      // Tick 2: retenção (90 dias) — o mês inteiro já passou do corte, então
      // é purgado ATOMICAMENTE (tudo ou nada, nunca uma fração).
      const apagados = await fechamentoReal.limparEventosAntigos(wrapAdmin, 90);
      assert.ok(apagados > 0, 'deveria ter apagado os eventos do mês (já fora da retenção)');
      const restantes = await admin.query(`SELECT count(*) AS n FROM consumo_evento WHERE tenant_id = $1`, [tenantId]);
      assert.equal(Number(restantes.rows[0].n), 0, 'a purga por mês inteiro não pode deixar sobra parcial');

      // Tick 3: mesmo sem NENHUM evento bruto sobrando, o total PERMANENTE
      // não pode ter mudado — é isso que a correção garante.
      const depois = await admin.query(
        `SELECT quantidade, custo_centavos FROM consumo_mensal WHERE tenant_id = $1 AND ano_mes = $2`, [tenantId, anoMes]
      );
      assert.equal(Number(depois.rows[0].quantidade), 3000, 'o total fechado não pode ter encolhido depois da retenção apagar o bruto');
      assert.equal(Number(depois.rows[0].custo_centavos), 150);
    } finally {
      await admin.query('DELETE FROM consumo_mensal WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE $1)', [`%-${marca}`]).catch(() => {});
      await admin.query('DELETE FROM consumo_evento WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE $1)', [`%-${marca}`]).catch(() => {});
      await admin.query('DELETE FROM tenant WHERE slug LIKE $1', [`%-${marca}`]).catch(() => {});
      await admin.end();
    }
  });

test('ACHADO DE REVIEW (P2): tick() fecha TODA competência pendente, não só o mês atual e o anterior (downtime de vários meses)', async () => {
  const fechados = [];
  const conn = {
    async execute(sql, binds = {}) {
      if (/SELECT set_config/i.test(sql)) return { rows: [] };
      if (/pg_try_advisory_xact_lock/i.test(sql)) return { rows: [{ ADQUIRIDO: true }] };
      if (/SELECT DISTINCT to_char\(criado_em, 'YYYY-MM'\) AS ano_mes FROM consumo_evento/i.test(sql)) {
        // Simula 4 meses de downtime: só "atual + anterior" NUNCA fecharia os
        // dois mais antigos, e a retenção jamais os apagaria (sem fechamento
        // correspondente em consumo_mensal).
        return { rows: [{ ANO_MES: '2026-01' }, { ANO_MES: '2026-02' }, { ANO_MES: '2026-06' }, { ANO_MES: '2026-07' }] };
      }
      if (/^SELECT tenant_id, tipo,/i.test(sql)) { fechados.push(binds.anoMes); return { rows: [] }; }
      if (/DELETE FROM consumo_evento/i.test(sql)) return { rowsAffected: 0 };
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  db.getConnection = async () => conn;
  await fechamento.tick();
  for (const mes of ['2026-01', '2026-02', '2026-06', '2026-07']) {
    assert.ok(fechados.includes(mes), `mês ${mes} deveria ter sido fechado — ele tinha evento bruto pendente`);
  }
});
