'use strict';
// FIL-84 — migração 021 (autoria de mensagem + ativação da IA por canal).
//
// Duas camadas, como no resto da suíte:
//  (1) CONTRATO — lê o .sql e confere o que não pode faltar. Roda sempre.
//  (2) INTEGRAÇÃO — Postgres real, só com TEST_DATABASE_URL.
//
// O que está sendo protegido: `scripts/migrar.js` reaplica TODO o histórico a
// cada deploy. Esta migração TEM backfill (diferente da 020), então "idempotente"
// aqui significa: o backfill roda UMA vez e nunca mais mexe em dado de ninguém.
// Reabrir para todo mundo, num deploy, um número que hoje só atende a allowlist
// seria um vazamento de atendimento — por isso o modo teste nasce LIGADO nos
// números que já estão em modo='ia', e nunca é reescrito depois.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SQL_021 = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '021_ia_handoff.sql'),
  'utf8'
);

test('021: mensagem.origem nasce NOT NULL, com default e CHECK dos 5 valores', () => {
  assert.match(SQL_021, /ALTER TABLE mensagem ADD COLUMN IF NOT EXISTS origem/i);
  assert.match(SQL_021, /SET DEFAULT 'sistema'/i);
  assert.match(SQL_021, /ALTER COLUMN origem SET NOT NULL/i);
  for (const v of ['cliente', 'atendente', 'ia', 'bot', 'sistema']) {
    assert.match(SQL_021, new RegExp(`'${v}'`), `origem tem que aceitar '${v}'`);
  }
  assert.match(SQL_021, /ck_msg_origem/);
});

test('021: backfill de origem só toca linha ainda NULL (idempotente por construção)', () => {
  assert.match(SQL_021, /UPDATE mensagem[\s\S]*?WHERE origem IS NULL/i,
    'o backfill precisa do WHERE origem IS NULL');
  assert.match(SQL_021, /direcao = 'in'[\s\S]*?'cliente'/i);
  assert.match(SQL_021, /atendente_id IS NOT NULL[\s\S]*?'atendente'/i);
});

test('021: ia_regra e ia_modo_teste com CHECK e default conservador', () => {
  assert.match(SQL_021, /ADD COLUMN IF NOT EXISTS ia_regra/i);
  assert.match(SQL_021, /ck_num_ia_regra/);
  assert.match(SQL_021, /'fora_horario'/);
  assert.match(SQL_021, /ia_modo_teste/);
  assert.match(SQL_021, /ck_num_ia_modo_teste/);
});

test('021: o backfill do modo teste roda UMA vez — guardado por existência da coluna', () => {
  // Sem a guarda, o admin que abriu o canal veria o modo teste voltar a ligar
  // sozinho no deploy seguinte.
  assert.match(SQL_021, /information_schema\.columns[\s\S]*?ia_modo_teste/i);
  assert.match(SQL_021, /UPDATE numero SET ia_modo_teste = 'S' WHERE modo = 'ia'/i);
});

test('021: ia_turno guarda o CAMINHO da mídia, nunca os bytes', () => {
  assert.match(SQL_021, /ALTER TABLE ia_turno ADD COLUMN IF NOT EXISTS midia_caminho/i);
  assert.match(SQL_021, /ADD COLUMN IF NOT EXISTS midia_mime/i);
  assert.ok(!/bytea/i.test(SQL_021), 'turno da IA não guarda binário');
});

test('021: ia_audio_seg entra nos CHECKs de consumo (senão o INSERT do STT é rejeitado)', () => {
  for (const c of ['ck_consevt_tipo', 'ck_consmensal_tipo']) {
    assert.match(SQL_021, new RegExp(`DROP CONSTRAINT IF EXISTS ${c}`));
    assert.match(SQL_021, new RegExp(`ADD  ?CONSTRAINT ${c}`));
  }
  const ocorrencias = SQL_021.match(/'ia_audio_seg'/g) || [];
  assert.equal(ocorrencias.length, 2, 'os dois CHECKs precisam do tipo novo');
});

// ---------------------------------------------------------------------------
// (2) Integração — Postgres real.
// ---------------------------------------------------------------------------
const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;

test('021 no Postgres real: reaplicável, defaults corretos e modo teste não regride',
  { skip: !URL_INTEGRACAO && 'defina TEST_DATABASE_URL para rodar (migrações 001-020 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `t021-${Date.now()}`;
    let numeroId = null;
    try {
      await admin.query(SQL_021);
      await admin.query(SQL_021); // reaplicar é o que o deploy faz

      const t = await admin.query(
        `INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}') RETURNING id`);
      const A = t.rows[0].id;

      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      const n = await admin.query(
        `INSERT INTO numero (phone_number_id, modo) VALUES ($1, 'ia')
         RETURNING id, ia_regra, ia_modo_teste`,
        [`pnid-${marca}`]);
      await admin.query('COMMIT');
      numeroId = n.rows[0].id;

      // Número NOVO nasce com os defaults (o backfill já rodou antes dele existir).
      assert.equal(n.rows[0].ia_regra, 'sempre');
      assert.equal(n.rows[0].ia_modo_teste, 'N');

      // O admin abre o canal…
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      await admin.query(`UPDATE numero SET ia_modo_teste = 'N' WHERE id = $1`, [numeroId]);
      await admin.query('COMMIT');

      // …e o deploy seguinte NÃO pode fechar de volta.
      await admin.query(SQL_021);
      const depois = await admin.query(`SELECT ia_modo_teste FROM numero WHERE id = $1`, [numeroId]);
      assert.equal(depois.rows[0].ia_modo_teste, 'N', 'a migração religou o modo teste num deploy');
    } finally {
      if (numeroId) await admin.query(`DELETE FROM numero WHERE id = $1`, [numeroId]).catch(() => {});
      await admin.query(`DELETE FROM tenant WHERE slug = $1`, [`a-${marca}`]).catch(() => {});
      await admin.end();
    }
  });
