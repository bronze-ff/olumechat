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

// Windows-1252 mapeia 0x80–0x9F pra caracteres imprimíveis (€, aspas curvas,
// travessão, …) — é o que o Excel do Windows/BR realmente grava nessa faixa
// ao exportar CSV. `buffer.toString('latin1')` mapeia essa MESMA faixa pros
// controles C1 do ISO-8859-1 puro, corrompendo silenciosamente qualquer € ou
// aspas curvas do arquivo. 5 codepoints (0x81, 0x8D, 0x8F, 0x90, 0x9D) são
// indefinidos no Windows-1252 — a tabela oficial da Microsoft mantém o
// próprio byte nesses casos, e é o que fazemos aqui.
const CP1252_0X80_0X9F = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** Windows-1252 puro (0xA0–0xFF é idêntico ao latin1; só 0x80–0x9F muda). */
function decodificarWindows1252(buffer) {
  let out = '';
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_0X80_0X9F[b - 0x80] : b);
  }
  return out;
}

/** UTF-8 com fallback pra Windows-1252: byte inválido em UTF-8 vira U+FFFD —
 *  se aparecer, o arquivo não era UTF-8 (típico de planilha exportada no
 *  Excel BR). Sem o fallback certo, acento virava mojibake no bloco. */
function decodificarTexto(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  return decodificarWindows1252(buffer);
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

// XLSX é um zip. O teto de 10MB do multer vale pros bytes COMPRIMIDOS — um
// zip bem compactado pode declarar um conteúdo descomprimido MUITO maior
// (zip bomb), e `workbook.xlsx.load()` infla tudo em memória ANTES de
// qualquer checagem de linhas. Por isso lemos o central directory do zip (é
// um formato estável, RFC apêndice do PKZIP) e somamos os tamanhos
// descomprimidos DECLARADOS por cada entrada — acima do teto, nem tentamos
// carregar. Isto não abre nem descomprime nada: só lê os cabeçalhos.
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CDH_SIG = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const TETO_XLSX_DESCOMPRIMIDO_PADRAO = Number(process.env.IA_EXTRACAO_XLSX_MAX_DESCOMPRIMIDO) || 50 * 1024 * 1024;

function localizarEOCD(buffer) {
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.length - i >= 4 && buffer.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

/** Soma os tamanhos descomprimidos DECLARADOS no central directory, sem
 *  descomprimir nada. `null` = não deu pra ler a estrutura (deixa o
 *  `workbook.xlsx.load()` decidir se é ArquivoInvalido). */
function somaTamanhoDescomprimidoXlsx(buffer) {
  const eocdOffset = localizarEOCD(buffer);
  if (eocdOffset < 0) return null;

  let totalEntradas = buffer.readUInt16LE(eocdOffset + 10);
  let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  // Zip64: sentinela 0xFFFF/0xFFFFFFFF aponta pro EOCD64 (fica logo antes do
  // locator, que fica logo antes do EOCD normal).
  if (totalEntradas === 0xffff || cdOffset === 0xffffffff) {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset < 0 || buffer.readUInt32LE(locatorOffset) !== ZIP64_EOCD_LOCATOR_SIG) return null;
    const eocd64Offset = Number(buffer.readBigUInt64LE(locatorOffset + 8));
    if (eocd64Offset < 0 || eocd64Offset + 56 > buffer.length || buffer.readUInt32LE(eocd64Offset) !== ZIP64_EOCD_SIG) return null;
    totalEntradas = Number(buffer.readBigUInt64LE(eocd64Offset + 32));
    cdOffset = Number(buffer.readBigUInt64LE(eocd64Offset + 48));
  }

  let soma = 0;
  let offset = cdOffset;
  for (let i = 0; i < totalEntradas; i++) {
    if (offset < 0 || offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CDH_SIG) return null;
    let tamanhoDescomprimido = buffer.readUInt32LE(offset + 24);
    const nomeLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const comentarioLen = buffer.readUInt16LE(offset + 32);

    if (tamanhoDescomprimido === 0xffffffff) {
      // zip64: tamanho real vem no campo extra (tag 0x0001).
      const extraStart = offset + 46 + nomeLen;
      const extraEnd = extraStart + extraLen;
      for (let p = extraStart; p + 4 <= extraEnd; ) {
        const tag = buffer.readUInt16LE(p);
        const tamCampo = buffer.readUInt16LE(p + 2);
        if (tag === 0x0001 && p + 4 + 8 <= extraEnd) { tamanhoDescomprimido = Number(buffer.readBigUInt64LE(p + 4)); break; }
        p += 4 + tamCampo;
      }
    }

    soma += tamanhoDescomprimido;
    offset += 46 + nomeLen + extraLen + comentarioLen;
  }
  return soma;
}

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
  const tetoDescomprimido = (opts && opts.tetoDescomprimidoBytes) || TETO_XLSX_DESCOMPRIMIDO_PADRAO;

  const tamanhoDeclarado = somaTamanhoDescomprimidoXlsx(buffer);
  if (tamanhoDeclarado != null && tamanhoDeclarado > tetoDescomprimido) {
    throw new LimiteExcedido(`Este arquivo se descomprime em mais de ${Math.round(tetoDescomprimido / (1024 * 1024))} MB — não pode ser processado.`);
  }

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

// Espelha server/ia/perfilStore.js::LIMITES.blocoTitulo — este módulo é
// puro de propósito (sem import do store), então a rota SEMPRE passa o valor
// real como 4º argumento; isto aqui só cobre quem chamar sem passar nada.
const LIMITE_TITULO_PADRAO = 120;

function truncarTitulo(titulo, limite) {
  const t = String(titulo || '').trim();
  return t.length > limite ? t.slice(0, limite).trim() : t;
}

/** Texto extraído → blocos propostos `{ titulo, conteudo }`. Só numera
 *  "Título (1/2)" quando de fato precisou dividir — um arquivo pequeno vira
 *  UM bloco com o título limpo. Nome de arquivo longo (ou perto do limite +
 *  sufixo " (n/m)") é truncado ANTES de montar o título — sem isso o preview
 *  gerava um título que o POST de salvar rejeitava por estourar o limite. */
function propostaBlocos(titulo, texto, max, limiteTitulo = LIMITE_TITULO_PADRAO) {
  const partes = partirEmBlocos(texto, max);
  if (!partes.length) return [];
  if (partes.length === 1) return [{ titulo: truncarTitulo(titulo, limiteTitulo), conteudo: partes[0] }];
  const sufixoMax = ` (${partes.length}/${partes.length})`.length;
  const base = truncarTitulo(titulo, Math.max(1, limiteTitulo - sufixoMax));
  return partes.map((conteudo, i) => ({ titulo: `${base} (${i + 1}/${partes.length})`, conteudo }));
}

module.exports = {
  ArquivoInvalido, LimiteExcedido, LIMITE_LINHAS_PADRAO, TETO_XLSX_DESCOMPRIMIDO_PADRAO,
  decodificarTexto, detectarDelimitador, renderarLinhas, somaTamanhoDescomprimidoXlsx,
  extrairCsv, extrairXlsx, extrairPdf,
  partirEmBlocos, propostaBlocos,
};
