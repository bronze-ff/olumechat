// Testes de ISOLAMENTO DE TENANT — requisito de SEGURANÇA (docs/PORTE.md §1.2).
//
// Duas camadas:
//   (1) CONTRATO — um Postgres de mentira que implementa a semântica que
//       importa (set_config local vs. de sessão, papel efetivo, RLS por
//       tenant) e é embrulhado pelo MESMO wrapper de conexão de db/pool.js.
//       Roda sempre, sem rede.
//   (2) INTEGRAÇÃO — contra um Postgres real com a migração 001 aplicada.
//       Roda só com TEST_DATABASE_URL no ambiente; sem ela é PULADO (a suíte
//       segue verde em máquina sem banco). É o teste que prova a RLS de fato.
//
// A armadilha que motiva tudo isto: o pooler do Neon roda PgBouncer em
// transaction mode — a mesma conexão física serve requisições de tenants
// diferentes em sequência. Estado de SESSÃO vaza; estado de TRANSAÇÃO não.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');

// ---------------------------------------------------------------------------
// (1) CONTRATO — Postgres de mentira, fiel no que importa.
// ---------------------------------------------------------------------------

/**
 * Client falso com a semântica de escopo do Postgres:
 *  - set_config(k, v, true)  → vale até COMMIT/ROLLBACK (transaction-scoped)
 *  - set_config(k, v, false) / SET SESSION → PERSISTE na conexão (é o vazamento)
 *  - SET LOCAL ROLE r        → papel efetivo até o fim da transação
 *  - SELECT/INSERT em `contato` respeitam a policy: só linhas do tenant do
 *    contexto, e só quando o papel efetivo não tem BYPASSRLS.
 */
function criarClientFalso({ linhas = [], roleConexaoIgnoraRls = true } = {}) {
  const estado = {
    linhas,
    ctxSessao: null,   // sobrevive ao COMMIT (só se alguém usar SET SESSION)
    ctxTransacao: null,
    roleSessao: 'dono_do_banco',
    roleTransacao: null,
    emTransacao: false,
    comandos: [],
  };
  const ctx = () => (estado.ctxTransacao !== null ? estado.ctxTransacao : estado.ctxSessao);
  const papel = () => estado.roleTransacao || estado.roleSessao;
  // O dono do banco no Neon tem rolbypassrls; o role de aplicação, não.
  const ignoraRls = () => (papel() === 'dono_do_banco' ? roleConexaoIgnoraRls : false);
  const visiveis = () =>
    (ignoraRls() ? estado.linhas : estado.linhas.filter((l) => String(l.tenant_id) === String(ctx())));

  return {
    estado,
    async query(text, values = []) {
      estado.comandos.push(text);
      const t = text.trim();

      if (/^BEGIN/i.test(t)) { estado.emTransacao = true; return { rows: [], rowCount: 0 }; }
      if (/^(COMMIT|ROLLBACK)/i.test(t)) {
        estado.emTransacao = false;
        estado.ctxTransacao = null;   // set_config(..., true) morre aqui
        estado.roleTransacao = null;  // SET LOCAL ROLE também
        return { rows: [], rowCount: 0 };
      }
      let m = /^SET\s+LOCAL\s+ROLE\s+([a-zA-Z_][\w$]*)/i.exec(t);
      if (m) { estado.roleTransacao = m[1]; return { rows: [], rowCount: 0 }; }
      m = /^SET\s+(SESSION\s+)?ROLE\s+([a-zA-Z_][\w$]*)/i.exec(t);
      if (m) { estado.roleSessao = m[2]; return { rows: [], rowCount: 0 }; }
      if (/set_config\(/i.test(t)) {
        const local = /,\s*true\s*\)/i.test(t);
        if (local) estado.ctxTransacao = values[0];
        else estado.ctxSessao = values[0]; // vaza entre requisições — não fazemos isso
        return { rows: [{ set_config: values[0] }], rowCount: 1 };
      }
      if (/^SET\s+/i.test(t)) { // SET SESSION qualquer coisa = estado de sessão
        estado.ctxSessao = values[0] ?? estado.ctxSessao;
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT/i.test(t) && /FROM\s+contato/i.test(t)) {
        return {
          rows: visiveis().map((l) => ({ id: l.id, tenant_id: l.tenant_id, nome_perfil: l.nome_perfil })),
          rowCount: visiveis().length,
          fields: [{ name: 'id' }, { name: 'tenant_id' }, { name: 'nome_perfil' }],
        };
      }
      if (/^INSERT\s+INTO\s+contato/i.test(t)) {
        const alvo = ctx();
        if (!ignoraRls() && alvo == null) { // WITH CHECK contra contexto nulo
          const err = new Error('new row violates row-level security policy for table "contato"');
          err.code = '42501';
          throw err;
        }
        const linha = { id: estado.linhas.length + 1, tenant_id: alvo, nome_perfil: values[0] };
        estado.linhas.push(linha);
        return { rows: [{ id: linha.id }], rowCount: 1, fields: [{ name: 'id' }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}

/** Instala um getConnection() que sempre entrega a MESMA conexão física
 *  (é o que o pooler faz) e devolve uma função de restauração. */
function comConexaoFixa(client) {
  const original = db.getConnection;
  const conn = db._wrapClient(client);
  const semFechar = { ...conn, close: async () => { await conn.rollback(); } };
  db.getConnection = async () => semFechar;
  return () => { db.getConnection = original; };
}

test('comTenant: tenant B NÃO enxerga a linha criada pelo tenant A', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    await db.comTenant(1, async (conn) => {
      await conn.execute('INSERT INTO contato (nome_perfil) VALUES (:n)', { n: 'Cliente do A' });
    });
    const vistoPeloB = await db.comTenant(2, async (conn) => {
      const r = await conn.execute('SELECT id, nome_perfil FROM contato');
      return r.rows;
    });
    assert.deepEqual(vistoPeloB, [], 'tenant B enxergou dado do tenant A — VAZAMENTO');

    const vistoPeloA = await db.comTenant(1, async (conn) => {
      const r = await conn.execute('SELECT id, nome_perfil FROM contato');
      return r.rows;
    });
    assert.equal(vistoPeloA.length, 1);
    assert.equal(vistoPeloA[0].NOME_PERFIL, 'Cliente do A');
  } finally {
    restaurar();
  }
});

test('comTenant: contexto NÃO vaza entre duas operações sequenciais na mesma conexão pooled', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    await db.comTenant(1, async (conn) => {
      await conn.execute('INSERT INTO contato (nome_perfil) VALUES (:n)', { n: 'Cliente do A' });
    });
    // Requisição seguinte reaproveita a MESMA conexão física e não abre
    // contexto: se o tenant 1 tivesse ficado grudado na sessão, veria a linha.
    assert.equal(client.estado.ctxSessao, null, 'contexto de tenant ficou na SESSÃO — vazaria no pooler');
    assert.equal(client.estado.ctxTransacao, null, 'contexto sobreviveu ao COMMIT');
    assert.equal(client.estado.roleSessao, 'dono_do_banco', 'papel de aplicação ficou grudado na sessão');
  } finally {
    restaurar();
  }
});

test('comTenant: usa set_config(..., true) e SET LOCAL ROLE — nunca SET SESSION', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    await db.comTenant(7, async (conn) => {
      await conn.execute('SELECT id FROM contato');
    });
    const cmds = client.estado.comandos;
    const setTenant = cmds.find((c) => /set_config/i.test(c));
    assert.ok(setTenant, 'não chamou set_config');
    assert.match(setTenant, /,\s*true\s*\)/, 'set_config sem o `true` final (não é transaction-scoped)');
    assert.ok(cmds.some((c) => /^SET\s+LOCAL\s+ROLE/i.test(c.trim())), 'não assumiu o papel de aplicação');
    assert.ok(!cmds.some((c) => /SET\s+SESSION/i.test(c)), 'usou SET SESSION — vaza no PgBouncer');
    assert.ok(cmds.some((c) => /^BEGIN/i.test(c.trim())), 'não abriu transação');
  } finally {
    restaurar();
  }
});

test('comTenant: SET LOCAL ROLE derruba o BYPASSRLS do dono do banco', async () => {
  // Sem trocar de papel, o dono do banco (rolbypassrls) atravessa a policy.
  // Este teste fixa que a troca acontece e que ela é o que isola.
  const client = criarClientFalso({
    linhas: [{ id: 1, tenant_id: '1', nome_perfil: 'Cliente do A' }],
  });
  const restaurar = comConexaoFixa(client);
  try {
    const semRole = process.env.DB_APP_ROLE;
    process.env.DB_APP_ROLE = ''; // desliga a troca de papel
    const comBypass = await db.comTenant(2, async (conn) => (await conn.execute('SELECT id FROM contato')).rows);
    assert.equal(comBypass.length, 1, 'cenário de controle: sem troca de papel o dono vê tudo');

    delete process.env.DB_APP_ROLE; // volta ao default (falatta_app)
    const semBypass = await db.comTenant(2, async (conn) => (await conn.execute('SELECT id FROM contato')).rows);
    assert.deepEqual(semBypass, [], 'com o papel de aplicação o tenant B não deve ver nada');
    if (semRole !== undefined) process.env.DB_APP_ROLE = semRole;
  } finally {
    restaurar();
  }
});

test('comTenant: erro dentro de fn faz ROLLBACK e propaga', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    await assert.rejects(
      db.comTenant(1, async (conn) => {
        await conn.execute('INSERT INTO contato (nome_perfil) VALUES (:n)', { n: 'não deve sobrar' });
        throw new Error('falha no meio da operação');
      }),
      /falha no meio da operação/
    );
    assert.ok(client.estado.comandos.some((c) => /^ROLLBACK/i.test(c.trim())), 'não deu ROLLBACK');
  } finally {
    restaurar();
  }
});

test('comTenant: tenantId inválido é recusado antes de tocar o banco', async () => {
  for (const ruim of [null, undefined, 0, -1, 'abc', '1; DROP TABLE contato', 1.5]) {
    await assert.rejects(db.comTenant(ruim, async () => 'nunca'), /tenantId inválido/);
  }
});

test('comTenant: DB_APP_ROLE com caractere inválido é recusado (sem interpolar no SQL)', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  const antes = process.env.DB_APP_ROLE;
  try {
    process.env.DB_APP_ROLE = 'app; DROP TABLE contato';
    await assert.rejects(db.comTenant(1, async () => 'nunca'), /DB_APP_ROLE inválido/);
  } finally {
    if (antes === undefined) delete process.env.DB_APP_ROLE; else process.env.DB_APP_ROLE = antes;
    restaurar();
  }
});

// ---------------------------------------------------------------------------
// (2) INTEGRAÇÃO — Postgres real com a migração 001 aplicada.
//     Habilite com TEST_DATABASE_URL (use a string DIRETA, sem "-pooler").
// ---------------------------------------------------------------------------

const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;
const semBanco = !URL_INTEGRACAO;

test('RLS real: tenant B não lê a linha do tenant A (Postgres de verdade)',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `t${Date.now()}`;
    try {
      const t = await admin.query(
        `INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}'), ('B ${marca}', 'b-${marca}')
         RETURNING id, slug`
      );
      const A = t.rows.find((r) => r.slug === `a-${marca}`).id;
      const B = t.rows.find((r) => r.slug === `b-${marca}`).id;

      // grava no tenant A, exatamente como o app faria
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      await admin.query('INSERT INTO contato (telefone, nome_perfil) VALUES ($1, $2)',
        [`55629${marca.slice(-8)}`, `Cliente do A ${marca}`]);
      await admin.query('COMMIT');

      // tenant B tenta ler
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(B)]);
      const doB = await admin.query('SELECT id FROM contato WHERE nome_perfil = $1', [`Cliente do A ${marca}`]);
      await admin.query('COMMIT');
      assert.equal(doB.rowCount, 0, 'VAZAMENTO: tenant B leu a linha do tenant A');

      // tenant A lê o próprio dado
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      const doA = await admin.query('SELECT id FROM contato WHERE nome_perfil = $1', [`Cliente do A ${marca}`]);
      await admin.query('COMMIT');
      assert.equal(doA.rowCount, 1, 'tenant A deveria ver o próprio contato');

      // sem contexto de tenant: nada é visível e nada pode ser gravado
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE falatta_app');
      const semCtx = await admin.query('SELECT id FROM contato');
      assert.equal(semCtx.rowCount, 0, 'sem contexto de tenant não pode haver linha visível');
      await assert.rejects(
        admin.query('INSERT INTO contato (telefone, nome_perfil) VALUES ($1, $2)', ['5562900000000', 'orfao']),
        /row-level security/i
      );
      await admin.query('ROLLBACK');
    } finally {
      await admin.query('BEGIN');
      await admin.query('DELETE FROM contato WHERE nome_perfil LIKE $1', [`%${marca}`]);
      await admin.query('DELETE FROM tenant WHERE slug LIKE $1', [`%-${marca}`]);
      await admin.query('COMMIT').catch(() => {});
      await admin.end();
    }
  });

test('RLS real: contexto de tenant não sobrevive ao COMMIT na mesma conexão',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real)' },
  async () => {
    const { Client } = require('pg');
    const c = new Client({ connectionString: URL_INTEGRACAO });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE falatta_app');
      await c.query("SELECT set_config('app.current_tenant_id', '1', true)");
      await c.query('COMMIT');
      // Mesma conexão física, "requisição" seguinte: nada pode ter sobrado.
      const r = await c.query(
        "SELECT current_setting('app.current_tenant_id', true) AS ctx, current_user AS usuario"
      );
      assert.ok(!r.rows[0].ctx, `contexto vazou para a requisição seguinte: ${r.rows[0].ctx}`);
      assert.notEqual(r.rows[0].usuario, 'falatta_app', 'o papel ficou grudado na sessão');
    } finally {
      await c.end();
    }
  });

test('RLS real: phone_number_id é único GLOBAL — outro tenant não registra o mesmo número',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real)' },
  async () => {
    // O webhook resolve o tenant A PARTIR do phone_number_id. Se dois tenants
    // pudessem registrar o mesmo, a mensagem de um cliente cairia no tenant
    // errado — por isso esta é a única unicidade não escopada por tenant.
    const { Client } = require('pg');
    const c = new Client({ connectionString: URL_INTEGRACAO });
    await c.connect();
    const marca = `p${Date.now()}`;
    const pnid = `pnid-${marca}`;
    try {
      const t = await c.query(
        `INSERT INTO tenant (nome, slug) VALUES ('A ${marca}', 'a-${marca}'), ('B ${marca}', 'b-${marca}')
         RETURNING id, slug`
      );
      const A = t.rows.find((r) => r.slug === `a-${marca}`).id;
      const B = t.rows.find((r) => r.slug === `b-${marca}`).id;

      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE falatta_app');
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(A)]);
      await c.query('INSERT INTO numero (phone_number_id, display_phone) VALUES ($1, $2)', [pnid, '5562...']);
      await c.query('COMMIT');

      // Tenant B tenta registrar o MESMO phone_number_id: tem de falhar por
      // violação de unicidade, e não passar por não enxergar a linha do A.
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE falatta_app');
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(B)]);
      await assert.rejects(
        c.query('INSERT INTO numero (phone_number_id, display_phone) VALUES ($1, $2)', [pnid, '5562...']),
        (err) => err.code === '23505' && /uq_num_pnid/.test(err.constraint || ''),
        'segundo tenant conseguiu registrar o mesmo phone_number_id'
      );
      await c.query('ROLLBACK');
    } finally {
      await c.query('BEGIN');
      await c.query('DELETE FROM numero WHERE phone_number_id = $1', [pnid]);
      await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`%-${marca}`]);
      await c.query('COMMIT').catch(() => {});
      await c.end();
    }
  });

test('RLS real: toda tabela tem RLS habilitada e policy (nenhuma esquecida)',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real)' },
  async () => {
    const { Client } = require('pg');
    const c = new Client({ connectionString: URL_INTEGRACAO });
    await c.connect();
    try {
      const semRls = await c.query(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND rowsecurity = false ORDER BY 1`
      );
      assert.deepEqual(semRls.rows.map((r) => r.tablename), [], 'tabelas sem RLS habilitada');

      const semPolicy = await c.query(
        `SELECT t.tablename FROM pg_tables t
          WHERE t.schemaname = 'public'
            AND NOT EXISTS (SELECT 1 FROM pg_policies p
                             WHERE p.schemaname = 'public' AND p.tablename = t.tablename)
          ORDER BY 1`
      );
      assert.deepEqual(semPolicy.rows.map((r) => r.tablename), [], 'tabelas sem policy');

      const semForce = await c.query(
        `SELECT relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity = false
          ORDER BY 1`
      );
      assert.deepEqual(semForce.rows.map((r) => r.relname), [], 'tabelas sem FORCE ROW LEVEL SECURITY');

      const role = await c.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'falatta_app'");
      assert.equal(role.rowCount, 1, 'role de aplicação falatta_app não existe');
      assert.equal(role.rows[0].rolbypassrls, false, 'falatta_app com BYPASSRLS anula toda a RLS');
    } finally {
      await c.end();
    }
  });
