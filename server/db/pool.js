// db/pool.js — Pool PostgreSQL (`pg`) apontando para o Neon + contexto de
// tenant. Substitui o pool node-oracledb do fork.
//
// A INTERFACE DE CONEXÃO É A MESMA do código legado — os módulos de negócio e
// os 40+ arquivos de teste que mockam `db.getConnection` continuam válidos:
//
//   const db = require('./db/pool');
//   const conn = await db.getConnection();
//   const r = await conn.execute(
//     'SELECT id, nome FROM contato WHERE telefone = :tel',  // binds :nome
//     { tel: '5562999990000' }
//   );
//   r.rows          // [{ ID: 1, NOME: '...' }]  ← chaves MAIÚSCULAS (como no Oracle)
//   r.rowsAffected  // linhas afetadas em INSERT/UPDATE/DELETE
//   await conn.commit();   // ou conn.rollback()
//   await conn.close();    // devolve ao pool (rollback implícito se não commitou)
//
//   // RETURNING ... INTO :id (estilo Oracle) segue funcionando:
//   const ins = await conn.execute(
//     'INSERT INTO tag (nome) VALUES (:n) RETURNING id INTO :id',
//     { n: 'vip', id: { type: db.tipos.NUMBER, dir: db.tipos.BIND_OUT } }
//   );
//   ins.outBinds.id[0]  // id gerado (array, como no node-oracledb)
//
//   // { autoCommit: true } no 3º argumento também é aceito:
//   await conn.execute('UPDATE ... WHERE id = :id', { id }, { autoCommit: true });
//
// Transação: o wrapper abre BEGIN de forma preguiçosa no primeiro execute()
// (semântica do Oracle: tudo é transacional até commit/rollback). close() sem
// commit dá ROLLBACK — igual ao comportamento anterior.
//
// ── MULTI-TENANT: use comTenant() ───────────────────────────────────────────
// TODA query de dados de tenant deve rodar dentro de comTenant(). Sem contexto
// as policies de RLS devolvem/aceitam ZERO linhas — não há acesso "sem tenant".
//
//   const { comTenant } = require('./db/pool');
//   const linhas = await comTenant(req.tenantId, async (conn) => {
//     const r = await conn.execute('SELECT * FROM conversa WHERE id = :id', { id });
//     return r.rows;                       // só linhas do tenant corrente
//   });
//   // fn ok  → COMMIT automático; fn lançou → ROLLBACK. Conexão volta ao pool.
//
// ⚠️ O contexto é setado com set_config('app.current_tenant_id', $1, true) —
// o `true` final (transaction-scoped) é OBRIGATÓRIO. NUNCA use SET SESSION:
// o pooler do Neon roda PgBouncer em transaction mode e a MESMA conexão serve
// outra requisição logo em seguida — SET SESSION vazaria o tenant A para a
// requisição do tenant B. Há teste dedicado disso em test/db-tenant.test.js.
//
// ⚠️ comTenant() também roda `SET LOCAL ROLE falatta_app` antes do set_config.
// O dono do banco no Neon (neondb_owner) tem rolbypassrls = true e ignora a
// RLS mesmo com FORCE — sem trocar de papel, as policies não valem nada (foi
// verificado no banco de dev: o tenant B lia a linha do tenant A). O role é
// criado pela migração 001; SET LOCAL é revertido no fim da transação, então
// convive com o pooler. Ajustável por DB_APP_ROLE (vazio desliga a troca —
// use SOMENTE se o usuário do DATABASE_URL já for NOBYPASSRLS).
'use strict';

const { Pool, types } = require('pg');
const { traduzir, tipos } = require('./sql');

// int8/numeric chegam como string por padrão no pg (precisão). Os ids e
// contagens deste schema cabem em Number — converte para preservar a forma
// que o código de negócio espera (r.rows[0].ID === 7, não '7').
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

let pool = null;

/**
 * Cria o pool e VERIFICA que o banco responde.
 * DATABASE_URL = connection string POOLED do Neon (PgBouncer).
 *
 * `new Pool()` não conecta — só guarda a configuração. Sem o `SELECT 1` daqui,
 * uma DATABASE_URL errada passaria batido no boot: o `/health` ficaria verde e
 * o webhook responderia 200 à Meta sem conseguir persistir o evento. Falhar no
 * boot é o comportamento certo — quem sobe o serviço vê o erro na hora.
 *
 * DB_SKIP_HEALTHCHECK=1 pula a verificação. Existe para cenário de teste que
 * precise de um pool sem banco atrás; NÃO use em produção (é justamente a
 * checagem que impede subir apontando para o lugar errado).
 */
async function initPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('[db] DATABASE_URL não definida (connection string pooled do Neon)');
  const novo = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 30_000,
  });
  novo.on('error', (err) => console.error('[db] erro em conexão ociosa do pool:', err.message));

  if (process.env.DB_SKIP_HEALTHCHECK !== '1') {
    try {
      const client = await novo.connect();
      try { await client.query('SELECT 1'); } finally { client.release(); }
    } catch (err) {
      // Não deixa o pool meio-criado para trás: um retry precisa começar limpo.
      await novo.end().catch(() => {});
      throw new Error(`[db] não foi possível conectar ao Postgres: ${err.message}`);
    }
  }

  pool = novo;
  console.log('[db] Pool Postgres inicializado');
  return pool;
}

async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

/** Linha do pg (chaves minúsculas) → forma legada (chaves MAIÚSCULAS). */
function linhaMaiuscula(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k.toUpperCase()] = row[k];
  return out;
}

/**
 * Embrulha um client do pg na interface legada { execute, commit, rollback,
 * close }. Exportada (como _wrapClient) para os testes de tenant embrulharem
 * um client falso e exercitarem o wrapper de verdade.
 */
function wrapClient(client) {
  let emTransacao = false;
  let fechado = false;

  async function begin() {
    if (!emTransacao) { await client.query('BEGIN'); emTransacao = true; }
  }

  return {
    async execute(sql, binds = {}, opts = {}) {
      if (fechado) throw new Error('execute: conexão já fechada');
      const { text, values, outNames } = traduzir(sql, binds);
      await begin();
      const r = await client.query(text, values);
      const resultado = {
        rows: (r.rows || []).map(linhaMaiuscula),
        rowsAffected: r.rowCount == null ? undefined : r.rowCount,
      };
      if (outNames.length) {
        const linha = (r.rows || [])[0];
        const campos = r.fields || [];
        resultado.outBinds = {};
        outNames.forEach((nome, idx) => {
          const campo = campos[idx];
          resultado.outBinds[nome] = [linha && campo ? linha[campo.name] : undefined];
        });
      }
      if (opts.autoCommit) { await client.query('COMMIT'); emTransacao = false; }
      return resultado;
    },
    async commit() {
      if (emTransacao) { await client.query('COMMIT'); emTransacao = false; }
    },
    async rollback() {
      if (emTransacao) { await client.query('ROLLBACK'); emTransacao = false; }
    },
    async close() {
      if (fechado) return;
      fechado = true;
      try {
        if (emTransacao) { await client.query('ROLLBACK'); emTransacao = false; }
      } finally {
        if (typeof client.release === 'function') client.release();
      }
    },
  };
}

/** Pega uma conexão do pool já na interface legada. */
async function getConnection() {
  if (!pool) await initPool();
  return wrapClient(await pool.connect());
}

const SQL_SET_TENANT = `SELECT set_config('app.current_tenant_id', :tid, true)`;

// Role sem BYPASSRLS assumido por transação (ver ⚠️ no topo). Nome vem de
// DB_APP_ROLE só para permitir outro nome em bancos já existentes; string
// vazia desliga a troca de papel.
function roleDaAplicacao() {
  const v = process.env.DB_APP_ROLE;
  return v === undefined ? 'falatta_app' : v.trim();
}

// Identificador não é parametrizável em SET ROLE — valida o formato em vez de
// interpolar cru (o valor vem do .env, mas concatenar identificador sem
// validar é um hábito que vira injeção no próximo call site).
function validarRole(role) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(role)) {
    throw new Error(`comTenant: DB_APP_ROLE inválido: ${JSON.stringify(role)}`);
  }
  return role;
}

/**
 * Roda `fn(conn)` dentro de uma transação com o papel de aplicação e o
 * contexto de tenant setados (ambos transaction-scoped). Commit no sucesso,
 * rollback no erro, conexão sempre devolvida ao pool. Ver exemplos no topo.
 * @param {number|string} tenantId  id do tenant (inteiro positivo)
 * @param {(conn: object) => Promise<T>} fn
 * @returns {Promise<T>} o retorno de fn
 * @template T
 */
async function comTenant(tenantId, fn) {
  const id = Number(tenantId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`comTenant: tenantId inválido: ${JSON.stringify(tenantId)}`);
  }
  const role = roleDaAplicacao();
  // via module.exports p/ respeitar mocks de db.getConnection nos testes
  const conn = await module.exports.getConnection();
  try {
    if (role) await conn.execute(`SET LOCAL ROLE ${validarRole(role)}`);
    await conn.execute(SQL_SET_TENANT, { tid: String(id) });
    const resultado = await fn(conn);
    await conn.commit();
    return resultado;
  } catch (err) {
    try { await conn.rollback(); } catch { /* prioriza o erro original */ }
    throw err;
  } finally {
    await conn.close();
  }
}

// Contador só para dar nomes ÚNICOS a savepoints concorrentes na MESMA
// transação (loops que chamam comSavepoint várias vezes) — não precisa ser
// por-conexão nem persistir entre chamadas.
let savepointSeq = 0;

/**
 * Roda `fn()` isolado num SAVEPOINT da transação corrente: se `fn` lançar,
 * só o que ELE tentou fazer sofre ROLLBACK — a transação do CHAMADOR continua
 * saudável e pode seguir commitando o resto do trabalho.
 *
 * Existe porque, sem savepoint, QUALQUER statement que falhe (constraint,
 * RLS, tabela ausente) marca a transação Postgres INTEIRA como abortada —
 * capturar a exceção em JS não desfaz isso: todo comando seguinte (exceto
 * ROLLBACK) devolve 25P02, e o COMMIT final vira ROLLBACK silencioso. É o
 * mesmo padrão já usado em lotes de mutação (api/conversas.js) e no bot
 * (bot/runtime.js) — centralizado aqui para quem faz escrita BEST-EFFORT
 * dentro da transação de alguém (ex.: consumo/registrar.js, FIL-77: medir
 * consumo não pode derrubar o envio da mensagem que já saiu pelo WhatsApp).
 *
 * Ainda assim RELANÇA o erro original (quem chama decide se ignora/loga —
 * ver o padrão em consumo/registrar.js) — só isola o dano no Postgres.
 * @param {object} conn conexão da transação em andamento
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function comSavepoint(conn, fn) {
  const nome = `sp_${++savepointSeq}`;
  await conn.execute(`SAVEPOINT ${nome}`);
  try {
    const resultado = await fn();
    await conn.execute(`RELEASE SAVEPOINT ${nome}`);
    return resultado;
  } catch (err) {
    await conn.execute(`ROLLBACK TO SAVEPOINT ${nome}`).catch(() => {});
    throw err;
  }
}

module.exports = {
  initPool,
  getConnection,
  closePool,
  comTenant,
  comSavepoint,
  tipos,
  _wrapClient: wrapClient, // uso em teste
};
