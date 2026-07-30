'use strict';
// FIL-96 — migração 025 (lead_comercial: a landing grava o lead no banco).
//
// Duas camadas, como no resto da suíte:
//  (1) CONTRATO — lê o .sql e confere o que não pode faltar. Roda sempre.
//  (2) INTEGRAÇÃO — Postgres real (TEST_DATABASE_URL): aplica a migração e
//      prova que o caminho de tenant (falatta_app) NÃO alcança esta tabela —
//      um tenant logado não pode ler o e-mail de quem preencheu a landing.
//
// Este lead é da OLUME, não de um tenant — mesmo padrão de `operador`
// (005) e `provedor_credencial` (015): policy USING(false) + REVOKE.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ARQUIVO = path.join(__dirname, '..', 'db', 'migrations', '025_lead_comercial.sql');
const SQL_025 = fs.readFileSync(ARQUIVO, 'utf8');
const SQL_EXECUTAVEL = SQL_025.replace(/--[^\n]*/g, '');

test('025: a tabela nasce com CREATE ... IF NOT EXISTS (o deploy reaplica tudo)', () => {
  assert.match(SQL_025, /CREATE TABLE IF NOT EXISTS lead_comercial\b/);
});

test('025: os três status do ticket estão no CHECK', () => {
  const m = SQL_025.match(/ck_leadcom_status[\s\S]{0,120}?status IN \(([^)]*)\)/);
  assert.ok(m, 'sem CHECK de status, um typo vira lead perdido para sempre');
  for (const status of ['novo', 'contatado', 'descartado']) {
    assert.match(m[1], new RegExp(`'${status}'`), `status ${status} fora do CHECK`);
  }
  assert.match(SQL_025, /status\s+varchar\(12\) NOT NULL DEFAULT 'novo'/);
});

test('025: campos que o formulário e a auditoria da origem precisam', () => {
  assert.match(SQL_025, /nome\s+varchar\(160\) NOT NULL/);
  assert.match(SQL_025, /empresa\s+varchar\(160\) NOT NULL/);
  assert.match(SQL_025, /email\s+varchar\(160\) NOT NULL/);
  assert.match(SQL_025, /tamanho_equipe\s+varchar\(60\)/);
  assert.match(SQL_025, /origem\s+varchar\(200\)/);
  assert.match(SQL_025, /user_agent\s+varchar\(300\)/);
  assert.match(SQL_025, /ip\s+varchar\(45\)/);
  assert.match(SQL_025, /observacao\s+text/);
  assert.match(SQL_025, /criado_em\s+timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(SQL_025, /atualizado_em\s+timestamptz NOT NULL DEFAULT now\(\)/);
});

test('025: SEM tenant_id — este lead é da Olume, não de um tenant', () => {
  assert.ok(!/tenant_id/.test(SQL_EXECUTAVEL), 'lead comercial da Olume não pertence a tenant nenhum — ver cabeçalho');
});

test('025: tabela FECHADA para o caminho de tenant (padrão da 015/005)', () => {
  assert.match(SQL_025, /ENABLE ROW LEVEL SECURITY/);
  assert.match(SQL_025, /FORCE ROW LEVEL SECURITY/);
  assert.match(SQL_025, /CREATE POLICY sem_acesso_por_tenant[\s\S]*?USING \(false\)[\s\S]*?WITH CHECK \(false\)/);
  assert.match(SQL_025, /REVOKE ALL ON lead_comercial FROM falatta_app/);
  assert.match(SQL_025, /REVOKE ALL ON SEQUENCE lead_comercial_id_seq FROM falatta_app/);
  assert.ok(!/\bGRANT\b/i.test(SQL_EXECUTAVEL), 'GRANT aqui reabriria a tabela para o tenant');
});

test('025: índices de filtro por status e de contagem de novos (badge do menu)', () => {
  assert.match(SQL_025, /CREATE INDEX IF NOT EXISTS ix_leadcom_status_criado[\s\S]*?\(status, criado_em DESC\)/);
  assert.match(SQL_025, /CREATE INDEX IF NOT EXISTS ix_leadcom_novo[\s\S]*?WHERE status = 'novo'/);
});

test('025: nada de DELETE/DROP/TRUNCATE — reaplicar não pode perder lead', () => {
  assert.ok(!/\b(DELETE FROM|TRUNCATE|DROP TABLE)\b/i.test(SQL_EXECUTAVEL));
});

// ---------------------------------------------------------------------------
// (2) Integração — Postgres real.
// ---------------------------------------------------------------------------
const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;

test('025 no Postgres real: operador grava/lê e o caminho de tenant não alcança a tabela',
  { skip: !URL_INTEGRACAO && 'defina TEST_DATABASE_URL para rodar (migrações 001-024 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `t025-${Date.now()}`;

    try {
      await admin.query(SQL_025);
      await admin.query(SQL_025); // reaplicar é o que o deploy faz

      const inserido = await admin.query(
        `INSERT INTO lead_comercial (nome, empresa, email, tamanho_equipe, origem, user_agent, ip)
         VALUES ($1, 'Empresa Teste', $2, '1 a 5 pessoas', 'utm_source=teste', 'node-test', '127.0.0.1')
         RETURNING id, status`,
        [`Lead ${marca}`, `${marca}@example.com`]
      );
      assert.equal(inserido.rows[0].status, 'novo', 'status nasce novo por DEFAULT');
      const id = inserido.rows[0].id;

      const atualizado = await admin.query(
        `UPDATE lead_comercial SET status = 'contatado', observacao = 'ligado' WHERE id = $1 RETURNING status, observacao`,
        [id]
      );
      assert.deepEqual(
        { status: atualizado.rows[0].status, observacao: atualizado.rows[0].observacao },
        { status: 'contatado', observacao: 'ligado' }
      );

      // O caminho de tenant não alcança a tabela.
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await assert.rejects(
        admin.query('SELECT count(*) FROM lead_comercial'),
        /permission denied/i,
        'VAZAMENTO: um tenant logado enxergaria e-mail de quem preencheu a landing'
      );
      await admin.query('ROLLBACK');
    } finally {
      await admin.query('ROLLBACK').catch(() => {});
      await admin.query(`DELETE FROM lead_comercial WHERE email LIKE $1`, [`%${marca}%`]).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
