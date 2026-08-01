// scripts/carga/estatistica.js — Percentis e formatação de tabela (FIL-110).
//
// Percentil por interpolação linear sobre a amostra ordenada. Com amostra
// pequena (um degrau de 50 conexões dá 50 pontos) o método do "índice
// arredondado" faz p95 e máximo colapsarem no mesmo valor, o que esconde
// exatamente a cauda que o teste procura.
'use strict';

/** @param {number[]} valores  @param {number} p 0..1 */
function percentil(valores, p) {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b);
  if (v.length === 1) return v[0];
  const pos = (v.length - 1) * p;
  const baixo = Math.floor(pos);
  const alto = Math.ceil(pos);
  if (baixo === alto) return v[baixo];
  return v[baixo] + (v[alto] - v[baixo]) * (pos - baixo);
}

function resumo(valores) {
  if (!valores.length) return { n: 0, p50: null, p95: null, p99: null, max: null, media: null };
  return {
    n: valores.length,
    p50: percentil(valores, 0.5),
    p95: percentil(valores, 0.95),
    p99: percentil(valores, 0.99),
    max: Math.max(...valores),
    media: valores.reduce((a, b) => a + b, 0) / valores.length,
  };
}

const ms = (v) => (v == null ? '—' : `${v.toFixed(1)} ms`);
const mb = (v) => (v == null ? '—' : `${(v / 1024 / 1024).toFixed(1)} MB`);

/** Tabela markdown a partir de cabeçalhos + linhas de strings. */
function tabela(cabecalhos, linhas) {
  const larguras = cabecalhos.map((h, i) =>
    Math.max(h.length, ...linhas.map((l) => String(l[i] ?? '').length)));
  const linha = (cels) => `| ${cels.map((c, i) => String(c ?? '').padEnd(larguras[i])).join(' | ')} |`;
  return [
    linha(cabecalhos),
    `| ${larguras.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...linhas.map(linha),
  ].join('\n');
}

module.exports = { percentil, resumo, ms, mb, tabela };
