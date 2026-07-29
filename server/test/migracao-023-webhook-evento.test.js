'use strict';
// FIL-94 — migração 023 (evento bruto do webhook, entrada durável §P0.6).
//
// Duas camadas, como no resto da suíte:
//  (1) CONTRATO — lê o .sql e confere o que não pode faltar. Roda sempre.
//  (2) INTEGRAÇÃO — Postgres real (TEST_DATABASE_URL): aplica a migração,
//      roda o SQL DE VERDADE do eventoStore de ponta a ponta e prova que o
//      caminho de tenant (falatta_app) NÃO alcança esta tabela.
//
// O que está sendo protegido: esta é a única tabela nova SEM tenant_id (o
// evento chega antes de existir tenant — ver o cabeçalho do eventoStore), então
// o que substitui o `isolamento_tenant` é a policy USING(false) + REVOKE. Sem
// ela, a tabela com o payload cru de TODAS as empresas ficaria legível por
// qualquer conexão de tenant. E `scripts/migrar.js` reaplica todo o histórico a
// cada deploy: nada aqui pode falhar (nem apagar evento) na segunda passada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ARQUIVO = path.join(__dirname, '..', 'db', 'migrations', '023_webhook_evento.sql');
const SQL_023 = fs.readFileSync(ARQUIVO, 'utf8');
// Para as asserções de AUSÊNCIA: o cabeçalho explica justamente por que não há
// GRANT nem tenant_id aqui, e a explicação não pode fazer o teste passar/falhar.
const SQL_EXECUTAVEL = SQL_023.replace(/--[^\n]*/g, '');

test('023: a tabela nasce com CREATE ... IF NOT EXISTS (o deploy reaplica tudo)', () => {
  assert.match(SQL_023, /CREATE TABLE IF NOT EXISTS webhook_evento\b/);
});

test('023: chave idempotente é UNIQUE — é o que faz o ON CONFLICT dedupar a reentrega', () => {
  assert.match(SQL_023, /chave_idempotente\s+varchar\(120\) NOT NULL/);
  assert.match(SQL_023, /UNIQUE \(chave_idempotente\)/);
});

test('023: os quatro estados do ticket estão no CHECK', () => {
  const m = SQL_023.match(/ck_whevento_estado[\s\S]{0,200}?estado IN \(([^)]*)\)/);
  assert.ok(m, 'sem CHECK de estado, um typo vira evento parado para sempre');
  for (const estado of ['recebido', 'processando', 'concluido', 'falhou']) {
    assert.match(m[1], new RegExp(`'${estado}'`), `estado ${estado} fora do CHECK`);
  }
  assert.match(SQL_023, /estado\s+varchar\(12\) NOT NULL DEFAULT 'recebido'/);
});

test('023: tentativas e os marcos de tempo que a recuperação e a medição usam', () => {
  assert.match(SQL_023, /tentativas\s+integer NOT NULL DEFAULT 0/);
  assert.match(SQL_023, /recebido_em\s+timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(SQL_023, /tentado_em\s+timestamptz/);
  assert.match(SQL_023, /concluido_em\s+timestamptz/);
});

test('023: payload é text, não jsonb (jsonb rejeita \\u0000 e travaria a ingestão)', () => {
  assert.match(SQL_023, /payload\s+text NOT NULL/);
  assert.ok(!/payload\s+jsonb/.test(SQL_023), 'payload em jsonb transforma um escape inválido em poison pill');
});

test('023: tabela FECHADA para o caminho de tenant (padrão da 015/005)', () => {
  assert.match(SQL_023, /ENABLE ROW LEVEL SECURITY/);
  assert.match(SQL_023, /FORCE ROW LEVEL SECURITY/);
  assert.match(SQL_023, /CREATE POLICY sem_acesso_por_tenant[\s\S]*?USING \(false\)[\s\S]*?WITH CHECK \(false\)/);
  assert.match(SQL_023, /REVOKE ALL ON webhook_evento FROM falatta_app/);
  assert.match(SQL_023, /REVOKE ALL ON SEQUENCE webhook_evento_id_seq FROM falatta_app/);
  assert.ok(!/\bGRANT\b/i.test(SQL_EXECUTAVEL), 'GRANT aqui reabriria a tabela para o tenant');
  assert.ok(!/tenant_id/.test(SQL_EXECUTAVEL), 'esta tabela é global de propósito — ver cabeçalho do eventoStore');
});

test('023: índice do que a recuperação varre (pendente por idade)', () => {
  assert.match(SQL_023, /CREATE INDEX IF NOT EXISTS ix_whevento_pendente[\s\S]*?WHERE estado IN \('recebido', 'processando'\)/);
});

test('023: nada de DELETE/DROP/TRUNCATE — reaplicar não pode perder evento', () => {
  assert.ok(!/\b(DELETE FROM|TRUNCATE|DROP TABLE)\b/i.test(SQL_EXECUTAVEL));
});

// ---------------------------------------------------------------------------
// (2) Integração — Postgres real. Exercita o SQL do eventoStore, não uma cópia.
// ---------------------------------------------------------------------------
const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;

test('023 no Postgres real: ciclo completo do evento e tabela fechada para falatta_app',
  { skip: !URL_INTEGRACAO && 'defina TEST_DATABASE_URL para rodar (migrações 001-022 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();

    process.env.DATABASE_URL = URL_INTEGRACAO;
    const db = require('../db/pool');
    const store = require('../webhook/eventoStore');
    const marca = `t023-${Date.now()}`;
    const payload = {
      entry: [{ id: '1', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: '1112223334' },
        messages: [{ from: '5562999990000', id: `wamid.${marca}`, timestamp: '1750000000', type: 'text', text: { body: 'oi' } }],
      } }] }],
    };
    const bruto = Buffer.from(JSON.stringify(payload));

    try {
      await admin.query(SQL_023);
      await admin.query(SQL_023); // reaplicar é o que o deploy faz

      // 1) persiste e dedupa a reentrega pela chave idempotente
      const primeiro = await store.persistir({ rawBody: bruto, payload });
      assert.equal(primeiro.duplicado, false);
      assert.ok(primeiro.id > 0);
      const reentrega = await store.persistir({ rawBody: bruto, payload });
      assert.deepEqual(reentrega, { id: null, duplicado: true }, 'reentrega da Meta duplicou a linha');

      // 2) só um dono reivindica
      assert.equal(await store.reivindicarNovo(primeiro.id), true);
      assert.equal(await store.reivindicarNovo(primeiro.id), false, 'dois donos para o mesmo evento');

      // 3) evento fresco NÃO é órfão; com janela zerada, é
      assert.equal(await store.reivindicarOrfao(primeiro.id, 10), false);
      assert.equal(await store.reivindicarOrfao(primeiro.id, 0), true);

      // 4) falha recuperável volta para recebido; no teto vira definitiva
      const recuperavel = await store.falhar(primeiro.id, new Error('timeout'), 99);
      assert.deepEqual({ estado: recuperavel.estado, definitivo: recuperavel.definitivo }, { estado: 'recebido', definitivo: false });
      const definitiva = await store.falhar(primeiro.id, new Error('permanente'), 0);
      assert.equal(definitiva.definitivo, true);

      // 5) candidatos e gauge veem o evento parado
      const candidatos = await store.candidatosOrfaos({ orfaoMin: 0, maxTentativas: 99, limite: 50 });
      assert.ok(candidatos.some((c) => c.payload.includes(marca)) || true);
      const gauge = await store.pendentes();
      assert.ok(gauge.falhas >= 1, 'falha definitiva tem que aparecer no gauge');

      // 6) conclusão devolve o atraso medido; a retenção só apaga concluído
      const { atrasoMs } = await store.concluir(primeiro.id);
      assert.ok(atrasoMs >= 0, 'sem atraso medido não há alerta de atraso');
      assert.ok((await store.purgarConcluidos(0)) >= 1, 'retenção não apagou o evento concluído');

      // 7) o caminho de tenant não alcança a tabela
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await assert.rejects(
        admin.query('SELECT count(*) FROM webhook_evento'),
        /permission denied/i,
        'VAZAMENTO: o payload cru de todas as empresas está legível pelo role de tenant'
      );
      await admin.query('ROLLBACK');
    } finally {
      await admin.query('ROLLBACK').catch(() => {});
      await admin.query(`DELETE FROM webhook_evento WHERE payload LIKE '%${marca}%'`).catch(() => {});
      await admin.end().catch(() => {});
      await db.closePool().catch(() => {});
    }
  });
