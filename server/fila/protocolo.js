// fila/protocolo.js — Protocolo de atendimento: YYMMDD + sequencial de 6 dígitos.
// Ex.: 260610100042. Sequence global (sem reset diário — o prefixo de data já
// dá legibilidade e a sequence garante unicidade; coluna PROTOCOLO é UNIQUE).
'use strict';

async function gerarProtocolo(conn) {
  const r = await conn.execute(
    `SELECT TO_CHAR(SYSDATE,'YYMMDD') || LPAD(MC_ZAP_SEQ_PROTOCOLO.NEXTVAL, 6, '0') AS P FROM DUAL`
  );
  return r.rows[0].P;
}

module.exports = { gerarProtocolo };
