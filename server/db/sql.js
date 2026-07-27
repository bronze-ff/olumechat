// db/sql.js — Helper de binds: SQL estilo Oracle (:nome) → PostgreSQL ($n).
//
// As ~244 queries do repo usam binds NOMEADOS (`:id`, `:tel`) e o driver `pg`
// só aceita POSICIONAIS (`$1`, `$2`). Este módulo faz a tradução — quem chama
// `conn.execute(sql, binds)` continua escrevendo binds nomeados, exatamente
// como antes. É usado por baixo dos panos pelo wrapper de conexão de
// `db/pool.js`; os módulos de negócio normalmente NÃO precisam chamá-lo.
//
// EXEMPLOS
//
//   const { traduzir } = require('./sql');
//
//   // 1) Binds nomeados → posicionais (bind repetido reusa o mesmo $n):
//   traduzir('SELECT * FROM contato WHERE id = :id OR pai_id = :id', { id: 7 })
//   // → { text: 'SELECT * FROM contato WHERE id = $1 OR pai_id = $1',
//   //     values: [7], outNames: [] }
//
//   // 2) `:nome` dentro de string ou comentário NÃO é bind:
//   traduzir("SELECT ':x' AS l FROM c -- filtra :depois\nWHERE id = :id", { id: 1 })
//   // → text: "SELECT ':x' AS l FROM c -- filtra :depois\nWHERE id = $1"
//
//   // 3) RETURNING ... INTO (estilo Oracle) vira RETURNING do Postgres; o
//   //    valor volta em result.outBinds.<nome>[0] (ver wrapper em pool.js):
//   traduzir('INSERT INTO tag (nome) VALUES (:n) RETURNING id INTO :id',
//            { n: 'vip', id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } })
//   // → { text: 'INSERT INTO tag (nome) VALUES ($1) RETURNING id',
//   //     values: ['vip'], outNames: ['id'] }
//
//   // 4) Specs de bind estilo oracledb são aceitos ({ val, type, dir }):
//   traduzir('UPDATE c SET n = :n WHERE id = :id',
//            { n: { type: tipos.STRING, val: 'x' }, id: 3 })
//   // → values: ['x', 3]
//
// REGRAS (iguais às do Oracle, que os testes do repo já emulam):
//   • bind no SQL sem valor no objeto  → erro (análogo ao ORA-01008)
//   • bind no objeto sem :nome no SQL  → erro (análogo ao ORA-01036)
//   • `::` (cast do Postgres) e `:=` não são binds.
//
// Valores jsonb: passe STRING JSON (JSON.stringify), não objeto JS — objeto
// simples é reservado para specs de bind.
'use strict';

// Constantes de tipo/direção compatíveis com os specs `oracledb.*` que o
// código legado usa. O TIPO é ignorado na tradução (o pg infere); só a
// DIREÇÃO importa (BIND_OUT participa do RETURNING ... INTO).
const tipos = Object.freeze({
  NUMBER: 'number',
  STRING: 'string',
  CLOB: 'clob',
  DB_TYPE_CLOB: 'clob',
  BIND_IN: 'in',
  BIND_OUT: 'out',
});

/** Um valor de bind é "spec" ({ val, type, dir }) ou valor cru? */
function ehSpec(v) {
  if (v === null || typeof v !== 'object') return false;
  if (v instanceof Date || Buffer.isBuffer(v) || Array.isArray(v)) return false;
  return 'val' in v || 'dir' in v || 'type' in v;
}

const RE_RETURNING_INTO =
  /\bRETURNING\b([\s\S]+?)\bINTO\b\s*(:[a-zA-Z_][a-zA-Z0-9_$]*(?:\s*,\s*:[a-zA-Z_][a-zA-Z0-9_$]*)*)\s*$/i;

/**
 * Traduz `sql` com binds nomeados para texto posicional do Postgres.
 * @param {string} sql   SQL com `:nome` (e opcionalmente `RETURNING ... INTO :n`)
 * @param {object} binds { nome: valor } ou { nome: { val, type, dir } }
 * @returns {{ text: string, values: any[], outNames: string[] }}
 */
function traduzir(sql, binds = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('traduzir: SQL vazio');
  if (binds === null || typeof binds !== 'object' || Array.isArray(binds)) {
    throw new Error('traduzir: binds deve ser um objeto { nome: valor }');
  }

  const outDeclarados = new Set(
    Object.keys(binds).filter((k) => ehSpec(binds[k]) && binds[k].dir === tipos.BIND_OUT)
  );

  // 1) RETURNING ... INTO :a[, :b] → RETURNING ... (out binds saem do SQL).
  let texto = sql;
  const outNames = [];
  const m = RE_RETURNING_INTO.exec(sql);
  if (m) {
    for (const nome of m[2].match(/:[a-zA-Z_][a-zA-Z0-9_$]*/g)) outNames.push(nome.slice(1));
    texto = sql.slice(0, m.index) + 'RETURNING' + m[1].replace(/[\s]+$/, '') + sql.slice(m.index + m[0].length);
    const semSpec = outNames.filter((n) => !outDeclarados.has(n));
    if (semSpec.length) {
      throw new Error(`traduzir: RETURNING INTO :${semSpec.join(', :')} sem spec { dir: tipos.BIND_OUT } nos binds`);
    }
  }
  const outSemInto = [...outDeclarados].filter((n) => !outNames.includes(n));
  if (outSemInto.length) {
    throw new Error(`traduzir: bind de saída :${outSemInto.join(', :')} sem cláusula RETURNING ... INTO no SQL`);
  }

  // 2) Varredura ciente de strings ('...'), identificadores ("..."), comentários
  //    de linha (--) e de bloco (/* */): só substitui :nome em SQL "vivo".
  const ordem = [];            // nomes na ordem do primeiro uso
  const posicao = new Map();   // nome → n do $n
  let saida = '';
  let i = 0;
  const n = texto.length;
  while (i < n) {
    const ch = texto[i];
    const prox = texto[i + 1];

    if (ch === "'") { // string literal ('' escapa aspas)
      let j = i + 1;
      while (j < n) {
        if (texto[j] === "'" && texto[j + 1] === "'") { j += 2; continue; }
        if (texto[j] === "'") { j++; break; }
        j++;
      }
      saida += texto.slice(i, j); i = j; continue;
    }
    if (ch === '"') { // identificador entre aspas
      let j = texto.indexOf('"', i + 1);
      j = j === -1 ? n : j + 1;
      saida += texto.slice(i, j); i = j; continue;
    }
    if (ch === '-' && prox === '-') { // comentário de linha
      let j = texto.indexOf('\n', i);
      j = j === -1 ? n : j;
      saida += texto.slice(i, j); i = j; continue;
    }
    if (ch === '/' && prox === '*') { // comentário de bloco
      let j = texto.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      saida += texto.slice(i, j); i = j; continue;
    }
    if (ch === ':' && (prox === ':' || prox === '=')) { // cast :: ou :=
      saida += texto.slice(i, i + 2); i += 2; continue;
    }
    if (ch === ':' && /[a-zA-Z_]/.test(prox || '')) { // bind!
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_$]/.test(texto[j])) j++;
      const nome = texto.slice(i + 1, j);
      if (!posicao.has(nome)) { ordem.push(nome); posicao.set(nome, ordem.length); }
      saida += `$${posicao.get(nome)}`;
      i = j; continue;
    }
    saida += ch; i++;
  }

  // 3) Conferência estrita (espelha ORA-01008 / ORA-01036).
  const declarados = new Set(Object.keys(binds).filter((k) => !outDeclarados.has(k)));
  const semValor = ordem.filter((nome) => !declarados.has(nome));
  if (semValor.length) throw new Error(`traduzir: bind :${semValor.join(', :')} sem valor nos binds`);
  const sobrando = [...declarados].filter((nome) => !posicao.has(nome));
  if (sobrando.length) throw new Error(`traduzir: bind :${sobrando.join(', :')} não existe no SQL`);

  const values = ordem.map((nome) => {
    const v = binds[nome];
    const cru = ehSpec(v) ? v.val : v;
    return cru === undefined ? null : cru;
  });

  return { text: saida, values, outNames };
}

/**
 * Devolve só os NOMES de bind `:nome` usados de fato em `sql`, na ordem da
 * primeira aparição — mesma varredura ciente de string/identificador/
 * comentário/`::`/`:=` de `traduzir()` (`::` de cast e `:=` NUNCA são bind).
 * Existe pra quem precisa dos nomes ANTES de ter os valores prontos (ex.:
 * bot/runtime.js monta os binds de um SQL livre a partir das variáveis
 * capturadas) — uma regex `/:nome/` própria erraria em "WHERE id = :x::int"
 * (o "::int" vira um bind fantasma chamado "int").
 * @param {string} sql
 * @returns {string[]}
 */
function nomesBinds(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('nomesBinds: SQL vazio');
  const ordem = [];
  const vistos = new Set();
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const prox = sql[i + 1];

    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      i = j; continue;
    }
    if (ch === '"') {
      let j = sql.indexOf('"', i + 1);
      j = j === -1 ? n : j + 1;
      i = j; continue;
    }
    if (ch === '-' && prox === '-') {
      let j = sql.indexOf('\n', i);
      j = j === -1 ? n : j;
      i = j; continue;
    }
    if (ch === '/' && prox === '*') {
      let j = sql.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      i = j; continue;
    }
    if (ch === ':' && (prox === ':' || prox === '=')) { i += 2; continue; }
    if (ch === ':' && /[a-zA-Z_]/.test(prox || '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_$]/.test(sql[j])) j++;
      const nome = sql.slice(i + 1, j);
      if (!vistos.has(nome)) { vistos.add(nome); ordem.push(nome); }
      i = j; continue;
    }
    i++;
  }
  return ordem;
}

module.exports = { traduzir, tipos, nomesBinds };
