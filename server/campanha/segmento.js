// campanha/segmento.js — SELECT seguro do admin para listar destinatários da
// campanha. Generaliza o padrão do bot (bot/runtime.js::executarConsulta):
//   - só SELECT, sem ';' (uma única statement);
//   - binds por :nome (impede injeção; valores nunca concatenados no SQL).
// O SELECT devolve uma coluna de telefone + as colunas que viram {{1}},{{2}}...
// do template. O preview envelopa em LIMIT (não FETCH FIRST, que pode colidir
// com um FETCH do próprio admin) — mesma técnica do GET /api/conversas.
//
// Multi-tenant (FIL-61): este módulo não abre conexão própria — recebe o
// `conn` de quem chama (api/campanhas.js), que já roda dentro de
// db.comTenant(). RLS filtra o SELECT livre do admin pelo tenant do contexto
// automaticamente; nenhuma mudança aqui é necessária para isso.
'use strict';


class SegmentoInvalido extends Error {}

/** Valida e devolve o SQL "cru" pronto pra envelopar. Lança SegmentoInvalido. */
function validarSql(sqlBruto) {
  let sql = String(sqlBruto || '').trim();
  // Tolera comentários ANTES do SELECT (-- linha e /* bloco */) — o exemplo da
  // UI começa com um comentário e o DBA costuma anotar a consulta.
  let antes;
  do {
    antes = sql;
    sql = sql.replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '').trim();
  } while (sql !== antes);
  sql = sql.replace(/;\s*$/, ''); // tolera 1 ';' final
  if (!sql) throw new SegmentoInvalido('Escreva o SELECT que lista os destinatários.');
  if (!/^select\s/i.test(sql)) throw new SegmentoInvalido('A consulta precisa começar com SELECT.');
  if (sql.includes(';')) throw new SegmentoInvalido('Use uma única consulta (sem ";").');
  // Defesa em profundidade: bloqueia leitura da tabela de senhas e chamadas a
  // pacotes que executam efeito colateral (um SELECT pode invocar função com
  // PRAGMA AUTONOMOUS_TRANSACTION). O ideal é rodar com usuário Oracle read-only.
  if (/\bMC_SENHAS\b/i.test(sql)) throw new SegmentoInvalido('Consulta não permitida (tabela protegida).');
  if (/\b(DBMS_|UTL_|DBMS_SQL|EXECUTE\s+IMMEDIATE)\b/i.test(sql)) {
    throw new SegmentoInvalido('Consulta não permitida (pacote/comando não autorizado).');
  }
  return sql;
}

/** Extrai os binds :nome do SQL, preenchendo com `params` (ou null). */
function extrairBinds(sql, params = {}) {
  const binds = {};
  for (const m of String(sql).matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    const nome = m[1];
    if (!(nome in binds)) binds[nome] = params[nome] !== undefined ? String(params[nome]) : null;
  }
  return binds;
}

/** Conta quantos destinatários o SELECT retorna. Postgres exige alias na
    subquery do FROM (Oracle aceitava sem). */
async function contarTotal(conn, sqlBruto, params) {
  const sql = validarSql(sqlBruto);
  const binds = extrairBinds(sql, params);
  const r = await conn.execute(`SELECT COUNT(*) AS QTD FROM (${sql}) AS seg`, binds);
  return Number(r.rows[0].QTD);
}

/** Amostra de até `limite` linhas (colunas em minúsculas, decodificadas). */
async function rodarPreview(conn, sqlBruto, params, limite = 50) {
  const sql = validarSql(sqlBruto);
  const binds = extrairBinds(sql, params);
  binds.mczap_lim = limite;
  const r = await conn.execute(
    `SELECT * FROM (${sql}) AS seg LIMIT :mczap_lim`, binds
  );
  return r.rows.map((row) => {
    const o = {};
    for (const [col, val] of Object.entries(row)) {
      o[col.toLowerCase()] = val == null ? null : String(val);
    }
    return o;
  });
}

/** Roda o SELECT completo (para o "preparar"). Devolve todas as linhas em
    minúsculas. O `pg` não tem um equivalente ao `maxRows` do oracledb no
    wrapper de conexão (db/pool.js só repassa `autoCommit`) — o teto de
    segurança contra um SELECT descontrolado é reproduzido embrulhando em
    LIMIT. Para volumes muito grandes (>100k) trocar por cursor. */
async function rodarCompleto(conn, sqlBruto, params) {
  const sql = validarSql(sqlBruto);
  const binds = extrairBinds(sql, params);
  binds.mczap_max = 100000;
  const r = await conn.execute(`SELECT * FROM (${sql}) AS seg LIMIT :mczap_max`, binds);
  return r.rows.map((row) => {
    const o = {};
    for (const [col, val] of Object.entries(row)) {
      o[col.toLowerCase()] = val == null ? null : String(val);
    }
    return o;
  });
}

module.exports = { SegmentoInvalido, validarSql, extrairBinds, contarTotal, rodarPreview, rodarCompleto };
