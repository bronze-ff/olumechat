'use strict';
// FIL-94 (review P1-1) — migração 024: outbox dos efeitos pós-commit do webhook.
//
// Duas camadas, como no resto da suíte:
//  (1) CONTRATO — lê o .sql e confere o que não pode faltar. Roda sempre.
//  (2) INTEGRAÇÃO — Postgres real (TEST_DATABASE_URL): grava o efeito COMO O
//      APP GRAVA (role falatta_app, dentro de contexto de tenant) e prova que a
//      empresa B não enxerga o efeito da A.
//
// O que está sendo protegido: ao contrário de `webhook_evento` (023, tabela de
// sistema global), o EFEITO nasce dentro do comTenant() do change e carrega dado
// de tenant (conversa, departamento, texto do cliente). Fora do bloco
// `isolamento_tenant`, e com GRANT, isso vazaria entre empresas — silenciosamente.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ARQUIVO = path.join(__dirname, '..', 'db', 'migrations', '024_webhook_efeito.sql');
const SQL_024 = fs.readFileSync(ARQUIVO, 'utf8');
// Para asserções de AUSÊNCIA: o cabeçalho explica por que não há FK aqui, e a
// explicação não pode fazer o teste passar nem falhar.
const SQL_EXECUTAVEL = SQL_024.replace(/--[^\n]*/g, '');

test('024: tabela nasce com CREATE ... IF NOT EXISTS (o deploy reaplica tudo)', () => {
  assert.match(SQL_024, /CREATE TABLE IF NOT EXISTS webhook_efeito\b/);
});

test('024: entra no bloco de RLS isolamento_tenant, com tenant_id e GRANT', () => {
  const bloco = SQL_024.match(/FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/);
  assert.ok(bloco, 'sem o bloco de RLS a tabela nova fica sem isolamento entre empresas');
  assert.match(bloco[1], /'webhook_efeito'/);
  assert.match(SQL_024, /FORCE ROW LEVEL SECURITY/);
  assert.match(SQL_024, /tenant_id = tenant_atual\(\)/);
  assert.match(SQL_024, /tenant_id\s+bigint NOT NULL DEFAULT tenant_atual\(\) REFERENCES tenant \(id\)/);
  assert.match(SQL_024, /GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_efeito\s+TO falatta_app/);
  assert.match(SQL_024, /UNIQUE \(tenant_id, id\)/, 'padrão do repo: toda tabela de tenant tem UNIQUE (tenant_id, id)');
});

test('024: payload é text, não jsonb (texto do cliente entra aqui — mesmo motivo da 023)', () => {
  assert.match(SQL_024, /payload\s+text NOT NULL/);
  assert.ok(!/payload\s+jsonb/.test(SQL_024));
});

test('024: o que o dispatcher precisa — evento_id, tipo e o marco de despacho', () => {
  assert.match(SQL_024, /evento_id\s+bigint NOT NULL/);
  assert.match(SQL_024, /tipo\s+varchar\(30\) NOT NULL/);
  assert.match(SQL_024, /despachado_em\s+timestamptz/);
  assert.match(SQL_024, /criado_em\s+timestamptz NOT NULL DEFAULT now\(\)/);
});

test('024: índice do que o dispatcher lê (pendente por evento)', () => {
  assert.match(
    SQL_024,
    /CREATE INDEX IF NOT EXISTS ix_whefeito_pendente[\s\S]*?webhook_efeito \(evento_id\)[\s\S]*?WHERE despachado_em IS NULL/
  );
});

test('024: SEM foreign key para webhook_evento (decisão, não esquecimento)', () => {
  // `webhook_evento` é tabela de sistema com REVOKE de falatta_app. Uma FK aqui
  // faria o INSERT de TODA mensagem recebida depender de checagem de integridade
  // contra ela — risco desnecessário no caminho mais quente do produto. A
  // limpeza de órfãos é explícita (efeitoStore::purgarDeEventosConcluidos).
  assert.ok(
    !/REFERENCES webhook_evento/i.test(SQL_EXECUTAVEL),
    'FK para tabela de sistema no caminho quente da ingestão — ver cabeçalho da 024'
  );
});

test('024: nada de DELETE/DROP/TRUNCATE — reaplicar não pode perder efeito', () => {
  assert.ok(!/\b(DELETE FROM|TRUNCATE|DROP TABLE)\b/i.test(SQL_EXECUTAVEL));
});

// ---------------------------------------------------------------------------
// (2) Integração — Postgres real.
// ---------------------------------------------------------------------------
const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;

test('024 no Postgres real: app grava o efeito no seu tenant e o outro tenant não vê',
  { skip: !URL_INTEGRACAO && 'defina TEST_DATABASE_URL para rodar (migrações 001-023 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `t024-${Date.now()}`;
    try {
      await admin.query(SQL_024);
      await admin.query(SQL_024); // reaplicar é o que o deploy faz

      const a = await admin.query(`INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}') RETURNING id`);
      const b = await admin.query(`INSERT INTO tenant (nome, slug) VALUES ('B ${marca}', 'b-${marca}') RETURNING id`);
      const A = a.rows[0].id;
      const B = b.rows[0].id;

      const comTenant = async (id, fn) => {
        await admin.query('BEGIN');
        await admin.query('SET LOCAL ROLE falatta_app');
        await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(id)]);
        try {
          const r = await fn();
          await admin.query('COMMIT');
          return r;
        } catch (err) {
          await admin.query('ROLLBACK');
          throw err;
        }
      };

      // É ASSIM que o app grava: role falatta_app, sem informar tenant_id
      // (vem do DEFAULT tenant_atual()) e sem precisar de GRANT em webhook_evento.
      const gravado = await comTenant(A, async () => {
        const r = await admin.query(
          `INSERT INTO webhook_efeito (evento_id, tipo, payload)
           VALUES (999999, 'bot_iniciar', $1) RETURNING id, tenant_id, despachado_em`,
          [JSON.stringify({ tipo: 'bot_iniciar', conversaId: 7, marca })]
        );
        return r.rows[0];
      });
      assert.equal(String(gravado.tenant_id), String(A), 'tenant_id tem que sair do tenant_atual() da transação');
      assert.equal(gravado.despachado_em, null, 'efeito nasce pendente');

      const vistoPeloB = await comTenant(B, async () =>
        (await admin.query(`SELECT id FROM webhook_efeito`)).rowCount);
      assert.equal(vistoPeloB, 0, 'VAZAMENTO: a empresa B enxerga efeito (com texto de cliente) da empresa A');

      // O caminho de sistema (conexão dona, BYPASSRLS) enxerga e marca.
      const marcado = await admin.query(
        `UPDATE webhook_efeito SET despachado_em = now()
          WHERE id = $1 AND tenant_id = $2 AND despachado_em IS NULL RETURNING id`,
        [gravado.id, A]
      );
      assert.equal(marcado.rowCount, 1);
    } finally {
      await admin.query('ROLLBACK').catch(() => {});
      for (const slug of [`a-${marca}`, `b-${marca}`]) {
        await admin.query(
          `DELETE FROM webhook_efeito WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = $1)`, [slug]).catch(() => {});
        await admin.query(`DELETE FROM tenant WHERE slug = $1`, [slug]).catch(() => {});
      }
      await admin.end().catch(() => {});
    }
  });
