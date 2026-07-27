// utils/texto.js — Convivência com banco WE8MSWIN1252 (sem suporte a emoji).
//
// O Oracle do Winthor usa charset WE8MSWIN1252: qualquer caractere fora do
// Latin-1 (emoji, símbolos, CJK...) vira '¿' ao gravar. Para não perder nada:
//   - codificar(): antes de gravar — escapa codepoints > 0xFF como \u{1f600}
//     (acentos passam direto, continuam legíveis no banco).
//   - decodificar(): ao ler — restaura os escapes para o caractere real.
// Round-trip seguro para QUALQUER texto: a barra invertida literal é escapada
// primeiro (\\), então um cliente que digite "\u{1f600}" não é corrompido.
//
// JSON (definição de fluxo, variáveis do bot): usar jsonAscii() — escapes
// \uXXXX padrão do JSON; o JSON.parse decodifica sozinho na leitura.
'use strict';

const ALTO = /[Ā-\u{10FFFF}]/gu;       // tudo acima do Latin-1
const ALTO_BMP = /[Ā-￿]/g;        // p/ JSON (\uXXXX por code unit)

function codificar(s) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(ALTO, (ch) => `\\u{${ch.codePointAt(0).toString(16)}}`);
}

function decodificar(s) {
  if (s === null || s === undefined) return s;
  return String(s).replace(/\\u\{([0-9a-fA-F]+)\}|\\\\/gu, (m, hex) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : '\\');
}

/** JSON.stringify 100% ASCII acima de 0xFF — JSON.parse restaura nativamente. */
function jsonAscii(obj) {
  return JSON.stringify(obj).replace(ALTO_BMP,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

module.exports = { codificar, decodificar, jsonAscii };
