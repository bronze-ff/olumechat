'use strict';
// FIL-85 — migração 022 (ferramentas por empresa, template e pedidos).
//
// Duas camadas, como no resto da suíte:
//  (1) CONTRATO — lê o .sql e confere o que não pode faltar. Roda sempre.
//  (2) INTEGRAÇÃO — Postgres real, só com TEST_DATABASE_URL.
//
// O que está sendo protegido: tabela nova FORA do bloco de RLS fica sem
// isolamento entre empresas, silenciosamente — e aqui trafega ficha de cliente
// e pedido. E `scripts/migrar.js` reaplica TODO o histórico a cada deploy: o
// único trecho que escreve dado (a renumeração de turnos duplicados) tem que
// rodar uma vez e nunca mais mexer em conversa de ninguém.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SQL_022 = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '022_ia_ferramenta_pedido.sql'),
  'utf8'
);

test('022: as três tabelas nascem com CREATE ... IF NOT EXISTS', () => {
  for (const t of ['ia_ferramenta', 'ia_pedido_template', 'ia_pedido']) {
    assert.match(SQL_022, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`), `${t} precisa ser idempotente`);
  }
});

test('022: as três entram no bloco de RLS isolamento_tenant', () => {
  const bloco = SQL_022.match(/FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/);
  assert.ok(bloco, 'sem o bloco de RLS a tabela nova fica sem isolamento');
  for (const t of ['ia_ferramenta', 'ia_pedido_template', 'ia_pedido']) {
    assert.match(bloco[1], new RegExp(`'${t}'`), `${t} fora do isolamento_tenant`);
  }
  assert.match(SQL_022, /FORCE ROW LEVEL SECURITY/);
  assert.match(SQL_022, /DROP POLICY IF EXISTS isolamento_tenant/);
  assert.match(SQL_022, /tenant_id = tenant_atual\(\)/);
});

test('022: tenant_id, GRANT e FK composta em toda tabela nova', () => {
  const grants = SQL_022.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON (\w+)/g) || [];
  const nomes = grants.map((g) => g.split(' ').pop());
  for (const t of ['ia_ferramenta', 'ia_pedido_template', 'ia_pedido']) {
    assert.ok(nomes.includes(t), `sem GRANT o app (falatta_app) não enxerga ${t}`);
    assert.match(SQL_022, new RegExp(`${t} \\([\\s\\S]*?tenant_id\\s+bigint NOT NULL`), `${t} sem tenant_id`);
  }
  // O vínculo com conversa/contato/atendente usa a chave COMPOSTA — é o que
  // impede um pedido de um tenant apontar para conversa de outro.
  assert.match(SQL_022, /FOREIGN KEY \(tenant_id, conversa_id\)/);
  assert.match(SQL_022, /FOREIGN KEY \(tenant_id, conferido_por\)/);
});

test('022: ia_ferramenta é só o interruptor, com CHECK S/N e sem seed', () => {
  assert.match(SQL_022, /ck_ia_ferramenta_ativo[\s\S]*?ativo IN \('S', 'N'\)/);
  assert.match(SQL_022, /PRIMARY KEY \(tenant_id, nome\)/, 'uma linha por ferramenta por empresa');
  assert.ok(!/INSERT INTO ia_ferramenta/i.test(SQL_022),
    'o default de cada ferramenta vive no catálogo (ia/operacoes.js), não em seed de migração');
});

test('022: ia_pedido tem status com CHECK, quem/quando conferiu e índice de leitura', () => {
  assert.match(SQL_022, /ck_ia_pedido_status[\s\S]*?'rascunho', 'conferido', 'descartado'/);
  assert.match(SQL_022, /status\s+varchar\(12\) NOT NULL DEFAULT 'rascunho'/);
  assert.match(SQL_022, /conferido_por bigint/);
  assert.match(SQL_022, /conferido_em\s+timestamptz/);
  assert.match(SQL_022, /CREATE INDEX IF NOT EXISTS ix_ia_pedido_status\s+ON ia_pedido \(tenant_id, status/);
});

test('022: o índice único de ia_turno é o que faz o ON CONFLICT do histórico funcionar', () => {
  assert.match(SQL_022, /CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_turno_numero\s+ON ia_turno \(tenant_id, conversa_id, numero_turno\)/);
});

test('022: a renumeração de turnos duplicados é guardada e NÃO apaga histórico', () => {
  assert.match(SQL_022, /IF EXISTS \([\s\S]*?HAVING count\(\*\) > 1[\s\S]*?\) THEN/,
    'sem a guarda, o bloco rodaria a cada deploy');
  assert.match(SQL_022, /row_number\(\) OVER \(PARTITION BY t\.tenant_id, t\.conversa_id/);
  assert.ok(!/DELETE FROM ia_turno/i.test(SQL_022), 'apagar turno é apagar histórico de conversa');
});

// ---------------------------------------------------------------------------
// (2) Integração — Postgres real.
// ---------------------------------------------------------------------------
const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;

test('022 no Postgres real: reaplicável, com RLS isolando um tenant do outro',
  { skip: !URL_INTEGRACAO && 'defina TEST_DATABASE_URL para rodar (migrações 001-021 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `t022-${Date.now()}`;
    try {
      await admin.query(SQL_022);
      await admin.query(SQL_022); // reaplicar é o que o deploy faz

      const a = await admin.query(
        `INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}') RETURNING id`);
      const b = await admin.query(
        `INSERT INTO tenant (nome, slug) VALUES ('B ${marca}', 'b-${marca}') RETURNING id`);
      const A = a.rows[0].id;
      const B = b.rows[0].id;

      const comTenant = async (id, fn) => {
        await admin.query('BEGIN');
        await admin.query('SET LOCAL ROLE falatta_app');
        await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(id)]);
        const r = await fn();
        await admin.query('COMMIT');
        return r;
      };

      // Tenant A cria contato + conversa + pedido.
      const pedidoA = await comTenant(A, async () => {
        const ct = await admin.query(`INSERT INTO contato (telefone) VALUES ($1) RETURNING id`, [`55${Date.now()}`.slice(0, 13)]);
        const cv = await admin.query(`INSERT INTO conversa (contato_id) VALUES ($1) RETURNING id`, [ct.rows[0].id]);
        await admin.query(
          `INSERT INTO ia_ferramenta (nome, ativo) VALUES ('registrar_pedido', 'S')`);
        await admin.query(
          `INSERT INTO ia_pedido_template (titulo, campos) VALUES ('Pedido', $1::jsonb)`,
          [JSON.stringify([{ nome: 'sabor', rotulo: 'Sabor', tipo: 'texto', obrigatorio: true }])]);
        const p = await admin.query(
          `INSERT INTO ia_pedido (conversa_id, contato_id, titulo, payload)
           VALUES ($1, $2, 'Pedido', $3::jsonb) RETURNING id, status`,
          [cv.rows[0].id, ct.rows[0].id, JSON.stringify({ titulo: 'Pedido', campos: { sabor: { rotulo: 'Sabor', tipo: 'texto', valor: 'Calabresa' } } })]);
        return p.rows[0];
      });
      assert.equal(pedidoA.status, 'rascunho', 'pedido nasce rascunho');

      // Tenant B não pode ver NADA do A.
      const vistoPeloB = await comTenant(B, async () => {
        const p = await admin.query(`SELECT id FROM ia_pedido`);
        const f = await admin.query(`SELECT nome FROM ia_ferramenta`);
        const t = await admin.query(`SELECT titulo FROM ia_pedido_template`);
        return { pedidos: p.rowCount, ferramentas: f.rowCount, templates: t.rowCount };
      });
      assert.deepEqual(vistoPeloB, { pedidos: 0, ferramentas: 0, templates: 0 },
        'VAZAMENTO entre tenants nas tabelas da 022');

      // Status inválido é barrado pelo CHECK.
      await assert.rejects(
        comTenant(A, () => admin.query(`UPDATE ia_pedido SET status = 'enviado' WHERE id = $1`, [pedidoA.id])),
        /ck_ia_pedido_status|violates check/i
      );
      await admin.query('ROLLBACK').catch(() => {});
    } finally {
      for (const slug of [`a-${marca}`, `b-${marca}`]) {
        await admin.query(
          `DELETE FROM ia_pedido WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = $1)`, [slug]).catch(() => {});
        await admin.query(
          `DELETE FROM ia_pedido_template WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = $1)`, [slug]).catch(() => {});
        await admin.query(
          `DELETE FROM ia_ferramenta WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = $1)`, [slug]).catch(() => {});
        await admin.query(
          `DELETE FROM conversa WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = $1)`, [slug]).catch(() => {});
        await admin.query(
          `DELETE FROM contato WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = $1)`, [slug]).catch(() => {});
        await admin.query(`DELETE FROM tenant WHERE slug = $1`, [slug]).catch(() => {});
      }
      await admin.end();
    }
  });
