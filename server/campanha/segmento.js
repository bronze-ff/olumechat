'use strict';

const { normalizar, variantes } = require('../utils/telefone');

class SegmentoInvalido extends Error {}

// CSV deliberately has a small, dependency-free parser: campaign imports are
// data, never executable text. Both comma and semicolon exports are accepted.
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (quoted && src[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === ';')) { row.push(cell); cell = ''; }
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some((v) => v.trim())) rows.push(row); }
  if (!rows.length) throw new SegmentoInvalido('O CSV está vazio.');
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length) throw new SegmentoInvalido('O cabeçalho do CSV tem colunas vazias ou repetidas.');
  const telefone = headers.findIndex((h) => ['telefone', 'celular', 'phone', 'whatsapp'].includes(h));
  if (telefone < 0) throw new SegmentoInvalido('O CSV precisa de uma coluna telefone.');
  return { headers, telefone, rows: rows.slice(1).map((r, i) => ({ linha: i + 2, values: headers.reduce((o, h, j) => { o[h] = r[j] == null ? '' : r[j].trim(); return o; }, {}) })) };
}

function validarTelefone(raw) {
  const d = normalizar(raw);
  // BR with DDD (10/11 digits before the automatic 55) or an explicit DDI.
  return (d.length >= 12 && d.length <= 15) ? d : null;
}

function validarImportacao(text, variaveis = []) {
  const csv = parseCsv(text); const vistos = new Set(); const aceitas = []; const rejeitadas = [];
  for (const linha of csv.rows) {
    const bruto = linha.values[csv.headers[csv.telefone]];
    const telefone = validarTelefone(bruto);
    if (!telefone) { rejeitadas.push({ linha: linha.linha, telefone: bruto, motivo: 'telefone_invalido' }); continue; }
    const chave = variantes(telefone).slice().sort().join('|');
    if (vistos.has(chave)) { rejeitadas.push({ linha: linha.linha, telefone: bruto, motivo: 'duplicado' }); continue; }
    vistos.add(chave);
    aceitas.push({ linha: linha.linha, telefone, variaveis: variaveis.map((c) => String(linha.values[String(c).toLowerCase()] || '')) });
  }
  return { headers: csv.headers, aceitas, rejeitadas };
}

function filtroAtributos(filtros = {}) {
  const where = ['ct.telefone IS NOT NULL']; const binds = {}; let n = 0;
  if (filtros.optin === 'S' || filtros.optin === 'N') { where.push(`ct.optin = :f${n}`); binds[`f${n++}`] = filtros.optin; }
  if (filtros.tag) { where.push(`(ct.tags_contato @> :f${n}::jsonb)`); binds[`f${n++}`] = JSON.stringify([String(filtros.tag)]); }
  if (filtros.departamentoId) { where.push(`EXISTS (SELECT 1 FROM conversa cv WHERE cv.contato_id = ct.id AND cv.departamento_id = :f${n})`); binds[`f${n++}`] = Number(filtros.departamentoId); }
  if (filtros.numeroId) { where.push(`EXISTS (SELECT 1 FROM conversa cv WHERE cv.contato_id = ct.id AND cv.numero_id = :f${n})`); binds[`f${n++}`] = Number(filtros.numeroId); }
  if (filtros.ultimaConversaDesde) { where.push(`EXISTS (SELECT 1 FROM conversa cv WHERE cv.contato_id = ct.id AND cv.ultima_msg_em >= :f${n})`); binds[`f${n++}`] = filtros.ultimaConversaDesde; }
  if (filtros.ultimaConversaAte) { where.push(`EXISTS (SELECT 1 FROM conversa cv WHERE cv.contato_id = ct.id AND cv.ultima_msg_em <= :f${n})`); binds[`f${n++}`] = filtros.ultimaConversaAte; }
  return { texto: `SELECT ct.telefone, ct.nome_perfil AS nome FROM contato ct WHERE ${where.join(' AND ')}`, binds };
}

module.exports = { SegmentoInvalido, parseCsv, validarImportacao, validarTelefone, filtroAtributos };
