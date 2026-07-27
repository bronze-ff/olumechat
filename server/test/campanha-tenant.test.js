// Testes de ISOLAMENTO DE TENANT para campanha/campanha_item (FIL-61,
// critérios de aceite). Segue o padrão de test/db-tenant.test.js (FIL-58):
// integração contra Postgres real via TEST_DATABASE_URL (use a string DIRETA,
// sem "-pooler") — sem ela, PULADO (a suíte segue verde em máquina sem banco).
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;
const semBanco = !URL_INTEGRACAO;

/** Roda `fn(client)` com o papel de aplicação e o tenant setados (ambos
    transaction-scoped) — o mesmo padrão de db.comTenant(), mas sobre o
    pg.Client cru usado só em teste de integração. */
async function comoTenant(client, tenantId, fn) {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE falatta_app');
  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(tenantId)]);
  try {
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

test('RLS real: campanha do tenant A não é visível nem disparável pelo tenant B',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `camp${Date.now()}`;
    try {
      const t = await admin.query(
        `INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}'), ('B ${marca}', 'b-${marca}')
         RETURNING id, slug`
      );
      const A = t.rows.find((r) => r.slug === `a-${marca}`).id;
      const B = t.rows.find((r) => r.slug === `b-${marca}`).id;

      const campanhaId = await comoTenant(admin, A, async (c) => {
        const ins = await c.query(
          `INSERT INTO campanha (nome, template_nome) VALUES ($1, 'lembrete') RETURNING id`,
          [`Campanha ${marca}`]
        );
        return ins.rows[0].id;
      });

      await comoTenant(admin, B, async (c) => {
        const vistoPeloB = await c.query('SELECT id FROM campanha WHERE id = $1', [campanhaId]);
        assert.equal(vistoPeloB.rowCount, 0, 'VAZAMENTO: tenant B enxergou a campanha do tenant A');

        // "Disparar" é um UPDATE de status — se a RLS falhar aqui, o tenant B
        // conseguiria iniciar o envio de uma campanha que não é dele.
        const disparo = await c.query(`UPDATE campanha SET status = 'enviando' WHERE id = $1`, [campanhaId]);
        assert.equal(disparo.rowCount, 0, 'VAZAMENTO: tenant B conseguiu disparar a campanha do tenant A');
      });

      await comoTenant(admin, A, async (c) => {
        const vistoPeloA = await c.query('SELECT id, status FROM campanha WHERE id = $1', [campanhaId]);
        assert.equal(vistoPeloA.rowCount, 1, 'tenant A deveria ver a própria campanha');
        assert.equal(vistoPeloA.rows[0].status, 'rascunho', 'o UPDATE do tenant B não deveria ter valido');
      });
    } finally {
      await admin.query(
        `DELETE FROM campanha_item WHERE campanha_id IN (SELECT id FROM campanha WHERE nome LIKE $1)`,
        [`%${marca}%`]
      ).catch(() => {});
      await admin.query(`DELETE FROM campanha WHERE nome LIKE $1`, [`%${marca}%`]).catch(() => {});
      await admin.query(`DELETE FROM tenant WHERE slug LIKE $1`, [`%-${marca}`]).catch(() => {});
      await admin.end();
    }
  });

test('RLS real: UNIQUE de campanha_item passou a incluir tenant — mesmo telefone em campanhas de tenants distintos não colide',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `dedup${Date.now()}`;
    const telefone = `55629${marca.slice(-8)}`;
    try {
      const t = await admin.query(
        `INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}'), ('B ${marca}', 'b-${marca}')
         RETURNING id, slug`
      );
      const A = t.rows.find((r) => r.slug === `a-${marca}`).id;
      const B = t.rows.find((r) => r.slug === `b-${marca}`).id;

      const campA = await comoTenant(admin, A, async (c) => {
        const camp = await c.query(`INSERT INTO campanha (nome) VALUES ($1) RETURNING id`, [`Campanha A ${marca}`]);
        await c.query(
          `INSERT INTO campanha_item (campanha_id, telefone, status) VALUES ($1, $2, 'pendente')`,
          [camp.rows[0].id, telefone]
        );
        return camp.rows[0].id;
      });

      // Mesmo telefone, MESMA campanha (mesmo tenant) → dedup continua atômico.
      await assert.rejects(
        comoTenant(admin, A, (c) => c.query(
          `INSERT INTO campanha_item (campanha_id, telefone, status) VALUES ($1, $2, 'pendente')`,
          [campA, telefone]
        )),
        (err) => err.code === '23505' && /uq_ci_camp_tel/.test(err.constraint || ''),
        'dedup por telefone dentro da mesma campanha não bloqueou a repetição'
      );

      // Mesmo telefone, campanha do tenant B → item DISTINTO, sem colisão.
      const campB = await comoTenant(admin, B, async (c) => {
        const camp = await c.query(`INSERT INTO campanha (nome) VALUES ($1) RETURNING id`, [`Campanha B ${marca}`]);
        await c.query(
          `INSERT INTO campanha_item (campanha_id, telefone, status) VALUES ($1, $2, 'pendente')`,
          [camp.rows[0].id, telefone]
        );
        return camp.rows[0].id;
      });
      assert.notEqual(campA, campB);

      // E o tenant A não enxerga o item do tenant B (mesmo telefone).
      await comoTenant(admin, A, async (c) => {
        const r = await c.query(`SELECT id FROM campanha_item WHERE campanha_id = $1`, [campB]);
        assert.equal(r.rowCount, 0, 'VAZAMENTO: tenant A enxergou item de campanha do tenant B');
      });
    } finally {
      await admin.query(`DELETE FROM campanha_item WHERE telefone = $1`, [telefone]).catch(() => {});
      await admin.query(`DELETE FROM campanha WHERE nome LIKE $1`, [`%${marca}%`]).catch(() => {});
      await admin.query(`DELETE FROM tenant WHERE slug LIKE $1`, [`%-${marca}`]).catch(() => {});
      await admin.end();
    }
  });
