'use strict';

// Mesma regra do client/src/observabilidade/idSessao.js: só inteiro positivo.
// E-mail, nome ou token não identificam ninguém no Sentry.

function inteiroPositivo(valor) {
  if (typeof valor === 'number') {
    return Number.isSafeInteger(valor) && valor > 0 ? valor : null;
  }
  if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function idInterno(prefixo, valor) {
  if (prefixo !== 'u' && prefixo !== 'o') return null;
  const n = inteiroPositivo(valor);
  return n == null ? null : `${prefixo}:${n}`;
}

function idAceito(id) {
  if (typeof id !== 'string') return null;
  const m = /^(u|o):([1-9]\d*)$/.exec(id);
  if (!m) return null;
  return idInterno(m[1], m[2]);
}

module.exports = { inteiroPositivo, idInterno, idAceito };
