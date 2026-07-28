// server/ia/extrairArquivo.js — extração de texto de PDF/XLSX/CSV para a base de
// conhecimento da IA (FIL-86). Funções PURAS (buffer in, texto/erro out) — sem
// banco, sem rede — para testar sem infraestrutura nenhuma. Quem persiste é o
// CRUD já existente (api/iaPerfil.js); este módulo só propõe blocos.
//
// Bibliotecas escolhidas pelo critério do ticket — zero binário nativo no
// deploy Windows: `pdfjs-dist` (zero dependências, JS puro — `pdf-parse`
// ficou de fora: além de empacotar um pdf.js desatualizado, seu `index.js`
// faz `!module.parent` para decidir se roda um autoteste ao ser importado, e
// `module.parent` não existe mais a partir do Node 22 — isso liga o autoteste
// SEMPRE, e o pdf.js embutido antigo não tolera duas extrações concorrentes
// compartilhando o estado global, quebrando com "bad XRef entry" mesmo em PDF
// válido) e `exceljs` (JS puro). CSV usa parser próprio, sem dependência —
// mesma filosofia do `campanha/segmento.js`: import é dado, nunca texto
// executável.
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

// pdfjs-dist@4 só publica build ESM (.mjs) — import() dinâmico funciona
// dentro de função async mesmo em módulo CommonJS. `standardFontDataUrl`
// aponta pras fontes padrão que a própria lib empacota (sem isso ela tenta
// buscar em rede, o que falharia/travaria num deploy sem acesso externo).
const FONTES_PADRAO_URL = pathToFileURL(
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep
).href;
let pdfjsPromise;
function carregarPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

class ArquivoInvalido extends Error {}
class LimiteExcedido extends Error {}

const LIMITE_LINHAS_PADRAO = Number(process.env.IA_EXTRACAO_MAX_LINHAS) || 10_000;

// ---------------------------------------------------------------------------
// Texto / encoding
// ---------------------------------------------------------------------------

/** UTF-8 com fallback pra latin1: byte inválido em UTF-8 vira U+FFFD — se
 *  aparecer, o arquivo não era UTF-8 (típico de planilha exportada no Excel
 *  br, WE8MSWIN1252/latin1). Sem isso, acento virava mojibake no bloco. */
function decodificarTexto(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  return buffer.toString('latin1');
}

/** Uma linha de texto por registro, colunas rotuladas pelo cabeçalho — célula
 *  vazia não aparece (senão "Coluna: " poluiria toda linha esparsa). Linha
 *  100% vazia é descartada. */
function renderarLinhas(headers, linhas) {
  const partes = [];
  for (const linha of linhas) {
    const campos = headers
      .map((h, i) => {
        const v = (linha[i] == null ? '' : String(linha[i])).trim();
        return v ? `${h || `Coluna ${i + 1}`}: ${v}` : null;
      })
      .filter(Boolean);
    if (campos.length) partes.push(campos.join(' · '));
  }
  return partes.join('\n');
}

// ---------------------------------------------------------------------------
// CSV — parser dependency-free (mesma filosofia de campanha/segmento.js),
// mas genérico (sem exigir coluna telefone) e com delimitador detectado.
// ---------------------------------------------------------------------------

function detectarDelimitador(linhaCabecalho) {
  let virgulas = 0; let pontoEVirgulas = 0; let aspas = false;
  const s = String(linhaCabecalho || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') aspas = !aspas;
    else if (!aspas && ch === ',') virgulas++;
    else if (!aspas && ch === ';') pontoEVirgulas++;
  }
  return pontoEVirgulas > virgulas ? ';' : ',';
}

/** Tokeniza e JÁ corta cedo se passar do teto de linhas — não espera montar o
 *  array inteiro para então descobrir que estourou (mesmo racional do
 *  `campanha/segmento.js::parseCsv`). */
function tokenizarCsv(texto, delimitador, limiteLinhas) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  function registrar() {
    if (!row.some((v) => v.trim())) return;
    rows.push(row);
    if (rows.length - 1 > limiteLinhas) {
      throw new LimiteExcedido(`O arquivo tem mais de ${limiteLinhas.toLocaleString('pt-BR')} linhas de dados — divida em partes menores.`);
    }
  }
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (ch === '"') {
      if (quoted && texto[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === delimitador) { row.push(cell); cell = ''; }
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      registrar();
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); registrar(); }
  return rows;
}

function extrairCsv(buffer, opts = {}) {
  const limiteLinhas = (opts && opts.limiteLinhas) || LIMITE_LINHAS_PADRAO;
  const texto = decodificarTexto(buffer).replace(/^﻿/, '');
  if (!texto.trim()) throw new ArquivoInvalido('O arquivo CSV está vazio.');
  const primeiraLinha = texto.split(/\r?\n/, 1)[0] || '';
  const delimitador = detectarDelimitador(primeiraLinha);
  const linhas = tokenizarCsv(texto, delimitador, limiteLinhas);
  if (!linhas.length) throw new ArquivoInvalido('O arquivo CSV está vazio.');
  const headers = linhas[0].map((h) => h.trim());
  const resultado = renderarLinhas(headers, linhas.slice(1));
  if (!resultado.trim()) throw new ArquivoInvalido('Não foi possível extrair dados deste CSV.');
  return resultado;
}

// ---------------------------------------------------------------------------
// XLSX — exceljs (JS puro)
// ---------------------------------------------------------------------------

/** exceljs devolve tipos variados por célula (rich text, fórmula com
 *  `.result`, hyperlink com `.text`, Date). Sem isso, uma célula com fórmula
 *  ou link viraria "[object Object]" no bloco. */
function celulaParaTexto(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString('pt-BR');
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined) return celulaParaTexto(v.result);
    if (v.text !== undefined) return String(v.text);
    return '';
  }
  return String(v);
}

async function extrairXlsx(buffer, opts = {}) {
  const limiteLinhas = (opts && opts.limiteLinhas) || LIMITE_LINHAS_PADRAO;
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new ArquivoInvalido('Não foi possível ler este arquivo XLSX.');
  }

  const planilhas = workbook.worksheets.filter((ws) => ws.rowCount > 0);
  let totalLinhasDados = 0;
  const blocosTexto = [];
  for (const ws of planilhas) {
    const linhasBrutas = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      linhasBrutas.push(row.values.slice(1).map(celulaParaTexto));
    });
    if (!linhasBrutas.length) continue;
    const headers = linhasBrutas[0].map((h) => String(h || '').trim());
    const dados = linhasBrutas.slice(1);
    totalLinhasDados += dados.length;
    if (totalLinhasDados > limiteLinhas) {
      throw new LimiteExcedido(`A planilha tem mais de ${limiteLinhas.toLocaleString('pt-BR')} linhas de dados — divida em partes menores.`);
    }
    const texto = renderarLinhas(headers, dados);
    if (texto) blocosTexto.push(planilhas.length > 1 ? `## ${ws.name}\n${texto}` : texto);
  }

  const resultado = blocosTexto.join('\n\n');
  if (!resultado.trim()) throw new ArquivoInvalido('Não foi possível extrair dados desta planilha.');
  return resultado;
}

// ---------------------------------------------------------------------------
// PDF — pdfjs-dist (sem binário nativo)
// ---------------------------------------------------------------------------

async function extrairPdf(buffer) {
  let doc;
  try {
    const pdfjs = await carregarPdfjs();
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      standardFontDataUrl: FONTES_PADRAO_URL,
      verbosity: 0,
    }).promise;

    let texto = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const pagina = await doc.getPage(i);
      const conteudo = await pagina.getTextContent();
      texto += conteudo.items.map((item) => item.str).join(' ') + '\n';
    }
    texto = texto.trim();
    if (!texto) {
      throw new ArquivoInvalido('Este PDF é uma imagem; envie o arquivo original ou cole o texto.');
    }
    return texto;
  } catch (err) {
    if (err instanceof ArquivoInvalido) throw err;
    throw new ArquivoInvalido('Não foi possível ler este PDF.');
  } finally {
    if (doc) await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Divisão em blocos — corta em fronteira de parágrafo (depois linha, depois
// corte duro), mesmo racional de ia/chunk.js::partirTexto, mas para o teto de
// 20.000 caracteres por bloco de conhecimento (não os 4096 de mensagem WhatsApp).
// ---------------------------------------------------------------------------

function partirEmBlocos(texto, max) {
  const s = String(texto || '').trim();
  if (!s) return [];
  if (s.length <= max) return [s];
  const partes = [];
  let resto = s;
  while (resto.length > max) {
    let corte = resto.lastIndexOf('\n\n', max);
    if (corte <= 0) corte = resto.lastIndexOf('\n', max);
    if (corte <= 0) corte = max;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).replace(/^\n+/, '');
  }
  if (resto.trim()) partes.push(resto.trim());
  return partes.filter((p) => p.length);
}

/** Texto extraído → blocos propostos `{ titulo, conteudo }`. Só numera
 *  "Título (1/2)" quando de fato precisou dividir — um arquivo pequeno vira
 *  UM bloco com o título limpo. */
function propostaBlocos(titulo, texto, max) {
  const partes = partirEmBlocos(texto, max);
  if (!partes.length) return [];
  if (partes.length === 1) return [{ titulo, conteudo: partes[0] }];
  return partes.map((conteudo, i) => ({ titulo: `${titulo} (${i + 1}/${partes.length})`, conteudo }));
}

module.exports = {
  ArquivoInvalido, LimiteExcedido, LIMITE_LINHAS_PADRAO,
  decodificarTexto, detectarDelimitador, renderarLinhas,
  extrairCsv, extrairXlsx, extrairPdf,
  partirEmBlocos, propostaBlocos,
};
