// Id de telemetria. Só inteiro positivo confirmado pelo servidor.
// Token no navegador não entra: a assinatura não foi conferida aqui, e o
// payload pode trazer um e-mail no lugar do id.

export function inteiroPositivo(valor) {
  if (typeof valor === 'number') {
    return Number.isSafeInteger(valor) && valor > 0 ? valor : null;
  }
  if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function idInterno(prefixo, valor) {
  if (prefixo !== 'u' && prefixo !== 'o') return null;
  const n = inteiroPositivo(valor);
  return n == null ? null : `${prefixo}:${n}`;
}

export function idAceito(id) {
  if (typeof id !== 'string') return null;
  const m = /^(u|o):([1-9]\d*)$/.exec(id);
  if (!m) return null;
  return idInterno(m[1], m[2]);
}

// `token` existe para o teste deixar explícito que ele é ignorado.
export function idDaSessao({ token, resposta, prefixo }) {
  void token;
  if (!resposta || typeof resposta !== 'object') return null;
  if (prefixo === 'o' && resposta.suporte === true) return idInterno('o', resposta.operadorId);
  if (prefixo === 'o') return idInterno('o', resposta.id);
  if (prefixo === 'u') return idInterno('u', resposta.usuarioId);
  return null;
}
