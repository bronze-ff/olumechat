'use strict';

const { normalizar, variantes } = require('../utils/telefone');

class SegmentoInvalido extends Error {}

// O multer já limita o upload a 10MB (ver api/campanhas.js), mas um arquivo
// dentro do teto de bytes ainda pode ter milhões de linhas curtas — o parse é
// SÍNCRONO e prenderia a thread do Node. Teto de linhas de DADOS (sem contar o
// cabeçalho), configurável por env, corta o abuso cedo.
const LIMITE_LINHAS_PADRAO = Number(process.env.CAMPANHA_CSV_MAX_LINHAS) || 50000;

// CSV deliberately has a small, dependency-free parser: campaign imports are
// data, never executable text. Both comma and semicolon exports are accepted.
function parseCsv(text, opts) {
  const limiteLinhas = (opts && opts.limiteLinhas) || LIMITE_LINHAS_PADRAO;
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = []; let row = []; let cell = ''; let quoted = false;
  function registrar() {
    if (!row.some((v) => v.trim())) return;
    rows.push(row);
    if (rows.length - 1 > limiteLinhas) {
      throw new SegmentoInvalido(`O CSV tem mais de ${limiteLinhas} linhas de dados — divida o arquivo em partes menores.`);
    }
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (quoted && src[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === ';')) { row.push(cell); cell = ''; }
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      registrar();
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); registrar(); }
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

function validarImportacao(text, variaveis = [], opts) {
  const csv = parseCsv(text, opts); const vistos = new Set(); const aceitas = []; const rejeitadas = [];
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

module.exports = { SegmentoInvalido, parseCsv, validarImportacao, validarTelefone, filtroAtributos, LIMITE_LINHAS_PADRAO };
