// utils/linhas.js — Mapeamento das linhas do banco (UPPER_CASE) → camelCase,
// a forma que a API devolve ao front. As chaves chegam em maiúsculas do
// wrapper de conexão (db/pool.js) e as datas viram ISO-8601.

function toCamel(str) {
  return str.toLowerCase().replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function mapRow(row) {
  if (!row) return null;
  const mapped = {};
  for (const key of Object.keys(row)) {
    const val = row[key];
    mapped[toCamel(key)] = val instanceof Date ? val.toISOString() : val;
  }
  return mapped;
}

function mapRows(rows) {
  if (!rows || !rows.length) return [];
  return rows.map(mapRow);
}

module.exports = { toCamel, mapRow, mapRows };
