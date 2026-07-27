// utils/telefone.js — Telefone brasileiro: normalização + 9º dígito.
//
// O problema do "nono dígito": celulares BR têm a forma 55 + DDD(2) + 9 + 8.
// A Meta MUITAS VEZES entrega o `from` SEM o 9 (55 + DDD + 8), enquanto o
// atendente digita COM o 9. Sem tratar isso, o MESMO cliente vira dois
// contatos (um da conversa ativa, outro da resposta dele) e a janela de 24h
// nunca "abre" na conversa certa. `variantes()` devolve as duas formas para
// casar o contato independentemente de como o número chegou.
'use strict';

/** Só dígitos; adiciona DDI 55 para números BR de 10/11 dígitos. */
function normalizar(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

/** Formas equivalentes do mesmo número BR (com e sem o 9). */
function variantes(raw) {
  const d = normalizar(raw);
  const set = new Set([d]);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const resto = d.slice(4);
    // 13 díg: celular com 9 → também a forma sem 9.
    if (resto.length === 9 && resto[0] === '9') set.add('55' + ddd + resto.slice(1));
    // 12 díg começando em 6-9 = celular SEM o 9 → também a forma com 9.
    // (Fixos começam em 2-5 e ficam só com a própria forma.)
    if (resto.length === 8 && /[6-9]/.test(resto[0])) set.add('55' + ddd + '9' + resto);
  }
  return [...set];
}

/** Acha o contato por qualquer variante do telefone. Devolve a linha ou null. */
async function acharContato(conn, telefone) {
  const vs = variantes(telefone);
  const binds = {};
  const marks = vs.map((v, i) => { binds['t' + i] = v; return ':t' + i; });
  const r = await conn.execute(
    `SELECT ID, NOME_PERFIL FROM MC_ZAP_CONTATO
      WHERE TELEFONE IN (${marks.join(',')})
      ORDER BY ID FETCH FIRST 1 ROWS ONLY`,
    binds
  );
  return r.rows.length ? r.rows[0] : null;
}

module.exports = { normalizar, variantes, acharContato };
