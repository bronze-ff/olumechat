// Testes de `acharContato` (utils/telefone.js) — FIL-95.
//
// A função consultava `MC_ZAP_CONTATO`, nome de tabela do fork Oracle que NÃO
// existe no Postgres (a migração 001 renomeou para `contato`). Como todos os
// testes do caminho de ingestão usam dublê de conexão, o nome errado passava
// batido: o dublê casava no nome antigo e devolvia linha. A primeira mensagem
// de cliente de verdade é que iria estourar "relation does not exist".
//
// Por isso duas camadas, no padrão de test/db-tenant.test.js:
//   (1) CONTRATO — dublê que só CAPTURA o SQL; garante que a query fala com uma
//       tabela que existe no schema. Roda sempre, sem rede — é o guarda que a
//       CI executa.
//   (2) INTEGRAÇÃO — Postgres real com a migração 001 aplicada; prova que a
//       query executa mesmo e que o casamento do 9º dígito acha o contato.
//       Roda só com TEST_DATABASE_URL; sem ela é PULADO.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const { acharContato } = require('../utils/telefone');

// Tabelas que a migração 001 criou de fato (o de→para dos nomes do fork está no
// cabeçalho dela). Se a query citar outra coisa, o banco recusa em produção.
const TABELAS_DO_SCHEMA = /\bFROM\s+contato\b/i;

// ---------------------------------------------------------------------------
// (1) CONTRATO
// ---------------------------------------------------------------------------

test('acharContato consulta a tabela `contato` (não o nome do fork Oracle)', async () => {
  const capturas = [];
  const conn = { async execute(sql, binds) { capturas.push({ sql, binds }); return { rows: [] }; } };

  await acharContato(conn, '5562998887777');

  assert.equal(capturas.length, 1, 'esperava exatamente uma query');
  const { sql } = capturas[0];
  assert.match(sql, TABELAS_DO_SCHEMA, 'acharContato precisa consultar `contato`');
  assert.doesNotMatch(sql, /MC_ZAP_/i, 'nome de tabela do fork Oracle não existe no Postgres');
});

test('acharContato busca TODAS as variantes do 9º dígito em binds parametrizados', async () => {
  const capturas = [];
  const conn = { async execute(sql, binds) { capturas.push({ sql, binds }); return { rows: [] }; } };

  await acharContato(conn, '5562998887777');

  const { sql, binds } = capturas[0];
  const valores = Object.values(binds);
  assert.deepEqual(valores.sort(), ['556298887777', '5562998887777'].sort());
  // Nenhum telefone concatenado no texto do SQL (WORKFLOW §6: input nunca vai cru).
  for (const v of valores) assert.ok(!sql.includes(v), `telefone ${v} não pode aparecer no SQL`);
});

// ---------------------------------------------------------------------------
// (2) INTEGRAÇÃO — Postgres real com a migração 001 aplicada.
//     Habilite com TEST_DATABASE_URL (use a string DIRETA, sem "-pooler").
// ---------------------------------------------------------------------------

const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;
const semBanco = !URL_INTEGRACAO;

test('acharContato acha o contato no Postgres real, casando o 9º dígito, e respeita a RLS',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();

    const marca = `t${Date.now()}`;
    // Gravado SEM o 9 (é como a Meta costuma entregar o `from`); a busca vem COM.
    const semNove = `556298${String(Date.now()).slice(-6)}`;
    const comNove = `55629${semNove.slice(4)}`;

    // Conexão na interface legada por cima do MESMO client — é assim que o
    // acharContato roda em produção (db/pool.js::comTenant).
    const conn = db._wrapClient({ query: (...a) => admin.query(...a), release: () => {} });
    const abrirComoTenant = async (tenantId) => {
      await conn.execute('SET LOCAL ROLE falatta_app');
      await conn.execute(`SELECT set_config('app.current_tenant_id', :tid, true)`, { tid: String(tenantId) });
    };

    try {
      const t = await admin.query(
        `INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}'), ('B ${marca}', 'b-${marca}')
         RETURNING id, slug`
      );
      const A = t.rows.find((r) => r.slug === `a-${marca}`).id;
      const B = t.rows.find((r) => r.slug === `b-${marca}`).id;

      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      await admin.query('INSERT INTO contato (telefone, nome_perfil) VALUES ($1, $2)',
        [semNove, `Cliente do A ${marca}`]);
      await admin.query('COMMIT');

      // tenant A busca COM o 9 → acha a linha gravada SEM o 9
      await abrirComoTenant(A);
      const achado = await acharContato(conn, comNove);
      await conn.rollback();
      assert.ok(achado, 'acharContato deveria achar o contato pela variante sem o 9');
      assert.equal(achado.NOME_PERFIL, `Cliente do A ${marca}`);

      // tenant B faz a MESMA busca → não pode enxergar nada do tenant A
      await abrirComoTenant(B);
      const doB = await acharContato(conn, comNove);
      await conn.rollback();
      assert.equal(doB, null, 'VAZAMENTO: tenant B achou o contato do tenant A');
    } finally {
      await conn.close().catch(() => {});
      await admin.query('BEGIN').catch(() => {});
      await admin.query('DELETE FROM contato WHERE nome_perfil LIKE $1', [`%${marca}`]).catch(() => {});
      await admin.query('DELETE FROM tenant WHERE slug LIKE $1', [`%-${marca}`]).catch(() => {});
      await admin.query('COMMIT').catch(() => {});
      await admin.end();
    }
  });
