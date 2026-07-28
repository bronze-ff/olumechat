'use strict';
// FIL-83 — migração 020 (ia_perfil + ia_conhecimento).
//
// Duas camadas, como no resto da suíte:
//  (1) CONTRATO — lê o .sql e confere o que não pode faltar. Roda sempre.
//  (2) INTEGRAÇÃO — Postgres real, só com TEST_DATABASE_URL (mesmo padrão de
//      db-tenant.test.js e migracao-014-*.test.js).
//
// O que está sendo protegido: tabela nova FORA do bloco `isolamento_tenant`
// fica sem isolamento entre empresas SILENCIOSAMENTE — e o conteúdo destas
// duas é literalmente o que a IA fala com o cliente final. E `scripts/migrar.js`
// reaplica TODO o histórico a cada deploy: a migração precisa ser idempotente
// de verdade, não só "não dá erro ao repetir".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SQL_020 = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '020_ia_perfil_conhecimento.sql'),
  'utf8'
);

test('020: as duas tabelas entram no bloco de RLS isolamento_tenant', () => {
  assert.match(SQL_020, /ARRAY\['ia_perfil',\s*'ia_conhecimento'\]/);
  assert.match(SQL_020, /DROP POLICY IF EXISTS isolamento_tenant/);
  assert.match(SQL_020, /CREATE POLICY isolamento_tenant/);
  assert.match(SQL_020, /ENABLE ROW LEVEL SECURITY/);
  assert.match(SQL_020, /FORCE ROW LEVEL SECURITY/);
  for (const t of ['ia_perfil', 'ia_conhecimento']) {
    assert.match(SQL_020, new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t}\\s+TO falatta_app`));
  }
});

test('020: idempotente por construção — nada de CREATE cru nem backfill', () => {
  assert.match(SQL_020, /CREATE TABLE IF NOT EXISTS ia_perfil/);
  assert.match(SQL_020, /CREATE TABLE IF NOT EXISTS ia_conhecimento/);
  assert.match(SQL_020, /CREATE INDEX IF NOT EXISTS/);
  // Sem INSERT/UPDATE/DELETE: rodar de novo não pode mexer em dado de ninguém.
  assert.ok(!/^\s*(INSERT|UPDATE|DELETE)\s/im.test(SQL_020.replace(/--.*$/gm, '')),
    'migração com escrita de dados deixa de ser idempotente de verdade');
});

test('020: tenant_id com DEFAULT tenant_atual() e FK para tenant nas duas tabelas', () => {
  const ocorrencias = SQL_020.match(/tenant_id\s+bigint NOT NULL DEFAULT tenant_atual\(\) REFERENCES tenant \(id\)/g) || [];
  assert.equal(ocorrencias.length, 2);
});

// ---------------------------------------------------------------------------
// (2) Integração — Postgres real.
// ---------------------------------------------------------------------------
const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;

test('020 no Postgres real: reaplicável, e o perfil do tenant A não é visível pelo tenant B',
  { skip: !URL_INTEGRACAO && 'defina TEST_DATABASE_URL para rodar (usa Postgres real, migrações 001-020 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `t020-${Date.now()}`;
    try {
      // Reaplicar é o que scripts/migrar.js faz a cada deploy.
      await admin.query(SQL_020);
      await admin.query(SQL_020);

      const t = await admin.query(
        `INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}'), ('B ${marca}', 'b-${marca}')
         RETURNING id, slug`
      );
      const A = t.rows.find((r) => r.slug === `a-${marca}`).id;
      const B = t.rows.find((r) => r.slug === `b-${marca}`).id;

      // Escreve como o app escreve: role de aplicação + contexto de transação.
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      await admin.query(`INSERT INTO ia_perfil (instrucoes, ficha) VALUES ($1, '{"endereco":"Rua A"}'::jsonb)`,
        [`segredo-do-A-${marca}`]);
      await admin.query(`INSERT INTO ia_conhecimento (titulo, conteudo) VALUES ('Cardápio', $1)`,
        [`bloco-do-A-${marca}`]);
      await admin.query('COMMIT');

      // Lê como o tenant B: RLS tem que devolver ZERO linhas.
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(B)]);
      const perfilB = await admin.query('SELECT * FROM ia_perfil');
      const blocosB = await admin.query('SELECT * FROM ia_conhecimento');
      await admin.query('COMMIT');

      assert.equal(perfilB.rows.length, 0, 'o tenant B enxergou o perfil de IA do tenant A');
      assert.equal(blocosB.rows.length, 0, 'o tenant B enxergou a base de conhecimento do tenant A');

      // E o próprio A continua enxergando o que gravou.
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      const perfilA = await admin.query('SELECT instrucoes FROM ia_perfil');
      await admin.query('COMMIT');
      assert.equal(perfilA.rows[0].instrucoes, `segredo-do-A-${marca}`);
    } finally {
      await admin.query(`DELETE FROM ia_conhecimento WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE $1)`, [`%-${marca}`]).catch(() => {});
      await admin.query(`DELETE FROM ia_perfil WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE $1)`, [`%-${marca}`]).catch(() => {});
      await admin.query(`DELETE FROM tenant WHERE slug LIKE $1`, [`%-${marca}`]).catch(() => {});
      await admin.end();
    }
  });
