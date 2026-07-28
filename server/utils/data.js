// utils/data.js — validação de data no formato AAAA-MM-DD usada pelos
// endpoints do operador (contrato, implementação, consumo). Regex sozinha
// aceita "2026-02-31" ou "2026-99-01" — a string PASSA no formato mas não é
// uma data de calendário real, e chega crua no Postgres como erro 500 em vez
// do 400 esperado pelo operador. `new Date(Date.UTC(...))` normaliza dias
// impossíveis (fevereiro rola pra março) — comparar os componentes de volta é
// o que denuncia a normalização e rejeita a data.
'use strict';

const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Lança se `v` não for uma data de calendário real em AAAA-MM-DD. Devolve a string normalizada. */
function validarDataYYYYMMDD(v, nomeCampo, ErroClasse) {
  const s = String(v || '');
  const m = RE_DATA.exec(s);
  if (!m) throw new ErroClasse(400, `${nomeCampo} inválida — use AAAA-MM-DD.`);
  const ano = Number(m[1]), mes = Number(m[2]), dia = Number(m[3]);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    throw new ErroClasse(400, `${nomeCampo} não é uma data de calendário válida.`);
  }
  return s;
}

/**
 * DATE do Postgres chega como `Date` interpretado em hora LOCAL do processo
 * (pg-types faz `new Date(ano, mês, dia)`, não UTC — ver postgres-date). Ler
 * os componentes locais (getFullYear/getMonth/getDate) evita a armadilha de
 * `toISOString()` (que converte pra UTC e pode empurrar a data em um fuso
 * positivo) — mesma classe de bug do achado de review sobre data sem fuso.
 */
function paraDataTexto(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

module.exports = { validarDataYYYYMMDD, paraDataTexto };
