// utils/oracleHelper.js — Mapeamento UPPER_CASE → camelCase (padrão web MC).

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
