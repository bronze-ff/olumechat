// server/ia/chunk.js — parte texto em pedaços ≤ max (limite Meta = 4096 chars/msg de texto).
'use strict';

function partirTexto(texto, max = 4096) {
  const s = String(texto || '');
  if (!s) return [];
  if (s.length <= max) return [s];
  const partes = [];
  let resto = s;
  while (resto.length > max) {
    let corte = resto.lastIndexOf('\n', max);
    if (corte <= 0) corte = max; // sem \n útil: corte duro
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte).replace(/^\n/, '');
  }
  if (resto.length) partes.push(resto);
  return partes.filter((p) => p.length);
}

module.exports = { partirTexto };
