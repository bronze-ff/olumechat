// Testes de ISOLAMENTO DE TENANT para consumo_evento/consumo_mensal/
// preco_provedor (FIL-77) — requisito de segurança (docs/SEGURANCA.md #1 e
// WORKFLOW.md #9: "teste de isolamento A/B obrigatório" em todo PR que toca
// query/pool/sessão).
//
// Duas camadas, MESMO padrão de test/db-tenant.test.js:
//   (1) CONTRATO — Postgres de mentira fiel na semântica de RLS por tenant.
//       Roda sempre, sem rede.
//   (2) INTEGRAÇÃO — Postgres real com as migrações 001..016 aplicadas.
//       Roda só com TEST_DATABASE_URL; sem ela é PULADO.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const registrar = require('../consumo/registrar');
const precos = require('../consumo/precos');

// ---------------------------------------------------------------------------
// (1) CONTRATO
// ---------------------------------------------------------------------------

/** Client falso com a MESMA semântica de escopo do Postgres usada em
 *  db-tenant.test.js, estendida para `consumo_evento` (isolamento_tenant) e
 *  `preco_provedor` (fechada — sem_acesso_por_tenant, USING(false)). */
function criarClientFalso({ eventos = [], precosCadastrados = [] } = {}) {
  const estado = {
    eventos, precosCadastrados,
    ctxTransacao: null,
    roleTransacao: null,
    roleSessao: 'dono_do_banco',
    emTransacao: false,
  };
  const ctx = () => estado.ctxTransacao;
  const papel = () => estado.roleTransacao || estado.roleSessao;
  const ignoraRls = () => papel() === 'dono_do_banco'; // dono do banco = comOperador (BYPASSRLS)
  const visiveis = () => (ignoraRls() ? estado.eventos : estado.eventos.filter((l) => String(l.tenant_id) === String(ctx())));

  return {
    estado,
    async query(text, values = []) {
      const t = text.trim();
      if (/^BEGIN/i.test(t)) { estado.emTransacao = true; return { rows: [], rowCount: 0 }; }
      if (/^(COMMIT|ROLLBACK)/i.test(t)) { estado.emTransacao = false; estado.ctxTransacao = null; estado.roleTransacao = null; return { rows: [], rowCount: 0 }; }
      let m = /^SET\s+LOCAL\s+ROLE\s+([a-zA-Z_][\w$]*)/i.exec(t);
      if (m) { estado.roleTransacao = m[1]; return { rows: [], rowCount: 0 }; }
      if (/set_config\(/i.test(t)) {
        if (/,\s*true\s*\)/i.test(t)) estado.ctxTransacao = values[0] || null;
        return { rows: [{ set_config: values[0] }], rowCount: 1 };
      }
      if (/^INSERT\s+INTO\s+consumo_evento/i.test(t)) {
        const alvo = ctx();
        if (!ignoraRls() && String(alvo) !== String(values[0])) {
          const err = new Error('new row violates row-level security policy for table "consumo_evento"');
          err.code = '42501';
          throw err;
        }
        estado.eventos.push({ tenant_id: values[0], tipo: values[1], quantidade: values[2] });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT.*FROM\s+consumo_evento/i.test(t)) {
        return { rows: visiveis().map((l) => ({ tenant_id: l.tenant_id, tipo: l.tipo, quantidade: l.quantidade })), rowCount: visiveis().length, fields: [] };
      }
      if (/FROM\s+preco_provedor/i.test(t)) {
        // Tabela FECHADA (migração 016): sem BYPASSRLS, USING(false) → zero linhas.
        return { rows: ignoraRls() ? estado.precosCadastrados : [], rowCount: 0, fields: [] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}

function comConexaoFixa(client) {
  const original = db.getConnection;
  const conn = db._wrapClient(client);
  const semFechar = { ...conn, close: async () => { await conn.rollback(); } };
  db.getConnection = async () => semFechar;
  return () => { db.getConnection = original; };
}

test('ISOLAMENTO A/B: consumo do tenant A não aparece para o tenant B (critério de aceite do ticket)', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    await db.comTenant(1, async (conn) => {
      await conn.execute(
        'INSERT INTO consumo_evento (tenant_id, tipo, quantidade, custo_centavos, referencia, criado_em) VALUES (:tenantId, :tipo, :qtd, :custo, :ref, now())',
        { tenantId: 1, tipo: 'ia_tokens', qtd: 500, custo: 10, ref: null }
      );
    });

    const vistoPeloB = await db.comTenant(2, async (conn) => {
      const r = await conn.execute('SELECT tenant_id, tipo, quantidade FROM consumo_evento');
      return r.rows;
    });
    assert.deepEqual(vistoPeloB, [], 'tenant B enxergou consumo do tenant A — VAZAMENTO');

    const vistoPeloA = await db.comTenant(1, async (conn) => {
      const r = await conn.execute('SELECT tenant_id, tipo, quantidade FROM consumo_evento');
      return r.rows;
    });
    assert.equal(vistoPeloA.length, 1);
    assert.equal(vistoPeloA[0].QUANTIDADE, 500);
  } finally {
    restaurar();
  }
});

test('DEFESA EM PROFUNDIDADE: WITH CHECK barra (e registrar() best-effort engole) gravação fora do contexto do tenant corrente', async () => {
  // Simula um bug hipotético: o código dentro de comTenant(10, ...) passa o
  // tenantId errado (9) para registrar(). A policy WITH CHECK da migração 016
  // tem que rejeitar — registrar() é best-effort e engole o erro (nunca
  // derruba o atendimento), mas a linha NÃO pode ser gravada sob tenant algum.
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    await db.comTenant(10, async (conn) => registrar.registrar(conn, 9, { tipo: 'mensagem_enviada', quantidade: 1 }));
    const vistoPeloNove = await db.comTenant(9, async (conn) => (await conn.execute('SELECT tenant_id FROM consumo_evento')).rows);
    const vistoPeloDez = await db.comTenant(10, async (conn) => (await conn.execute('SELECT tenant_id FROM consumo_evento')).rows);
    assert.deepEqual(vistoPeloNove, [], 'não pode ter gravado sob o tenant 9 (o passado por engano à função)');
    assert.deepEqual(vistoPeloDez, [], 'não pode ter gravado sob o tenant 10 (o do contexto) nem sob nenhum outro');
  } finally {
    restaurar();
  }
});

test('preco_provedor: FECHADA para o caminho de tenant — comTenant() não enxerga preço nenhum', async () => {
  const client = criarClientFalso({
    precosCadastrados: [{ provider: 'anthropic', modelo: 'claude-x', preco_entrada_centavos_1k: 5, preco_saida_centavos_1k: 15 }],
  });
  const restaurar = comConexaoFixa(client);
  try {
    const viaTenant = await db.comTenant(1, async (conn) => (await conn.execute('SELECT * FROM preco_provedor')).rows);
    assert.deepEqual(viaTenant, [], 'caminho de tenant não pode ler a tabela de preço do operador');
  } finally {
    restaurar();
  }
});

// ---------------------------------------------------------------------------
// (2) INTEGRAÇÃO — Postgres real, migrações 001..016 aplicadas.
// ---------------------------------------------------------------------------
const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;
const semBanco = !URL_INTEGRACAO;

test('RLS real: consumo_evento do tenant A não aparece pro tenant B, e preco_provedor é fechada pro falatta_app',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real, migrações 001-016 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `c${Date.now()}`;
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
      await admin.query(
        `INSERT INTO consumo_evento (tenant_id, tipo, quantidade, custo_centavos) VALUES ($1, 'ia_tokens', 1000, 25)`,
        [A]
      );
      await admin.query('COMMIT');

      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(B)]);
      const doB = await admin.query('SELECT id FROM consumo_evento WHERE tenant_id = $1', [A]);
      await admin.query('COMMIT');
      assert.equal(doB.rowCount, 0, 'VAZAMENTO: tenant B leu o consumo do tenant A');

      // preco_provedor: falatta_app não enxerga NADA, nem do próprio contexto.
      // A migração 016 fecha a tabela em DUAS camadas — `REVOKE ALL ... FROM
      // falatta_app` e policy `USING (false)`. A do GRANT dispara primeiro, e
      // num schema construído só pelas migrações o que se vê é 42501
      // (permission denied), não "0 linhas". As duas formas provam a mesma
      // propriedade (preço nunca vaza pro caminho de tenant); o que NÃO pode
      // acontecer é vir linha. ROLLBACK em vez de COMMIT porque um 42501
      // aborta a transação inteira (FIL-98).
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      let linhasDePreco = null;
      try {
        linhasDePreco = (await admin.query('SELECT * FROM preco_provedor')).rowCount;
      } catch (err) {
        assert.equal(err.code, '42501',
          `esperava permission denied em preco_provedor, veio ${err.code}: ${err.message}`);
      }
      await admin.query('ROLLBACK');
      assert.ok(linhasDePreco === null || linhasDePreco === 0,
        `preco_provedor deveria ser invisível ao caminho de tenant (veio ${linhasDePreco} linha(s))`);
    } finally {
      // O end() TEM de acontecer mesmo se a limpeza falhar: um client aberto
      // segura o event loop e o processo do node:test nunca sai — foi assim
      // que um único teste vermelho virou um job de CI pendurado (FIL-98).
      try {
        await admin.query('BEGIN').catch(() => {});
        await admin.query('DELETE FROM consumo_evento WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE $1)', [`%-${marca}`]).catch(() => {});
        await admin.query('DELETE FROM tenant WHERE slug LIKE $1', [`%-${marca}`]).catch(() => {});
        await admin.query('COMMIT').catch(() => {});
      } finally {
        await admin.end().catch(() => {});
      }
    }
  });

test('RLS real: fecharMes agrega consumo_evento em consumo_mensal e a agregação também respeita o tenant',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real, migrações 001-016 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `f${Date.now()}`;
    try {
      const t = await admin.query(`INSERT INTO tenant (nome, slug) VALUES ('F ${marca}', 'f-${marca}') RETURNING id`);
      const tenantId = t.rows[0].id;
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(tenantId)]);
      await admin.query(`INSERT INTO consumo_evento (tenant_id, tipo, quantidade, custo_centavos) VALUES ($1, 'ia_tokens', 700, 14)`, [tenantId]);
      await admin.query('COMMIT');

      const fechamento = require('../consumo/fechamento');
      const wrapAdmin = require('../db/pool')._wrapClient({ query: (...a) => admin.query(...a), release: () => {} });
      const anoMes = new Date().toISOString().slice(0, 7);
      await fechamento.fecharMes(wrapAdmin, anoMes);
      await fechamento.fecharMes(wrapAdmin, anoMes); // idempotência com banco de verdade

      const r = await admin.query('SELECT quantidade, custo_centavos FROM consumo_mensal WHERE tenant_id = $1 AND ano_mes = $2', [tenantId, anoMes]);
      assert.equal(r.rowCount, 1, 'esperava exatamente 1 linha (idempotente, não duplicou)');
      assert.equal(Number(r.rows[0].quantidade), 700);
    } finally {
      await admin.query('DELETE FROM consumo_mensal WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE $1)', [`%-${marca}`]).catch(() => {});
      await admin.query('DELETE FROM consumo_evento WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE $1)', [`%-${marca}`]).catch(() => {});
      await admin.query('DELETE FROM tenant WHERE slug LIKE $1', [`%-${marca}`]).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
