'use strict';

const { variantes } = require('../utils/telefone');

// Casa o telefone do remetente contra a lista de autorizados TOLERANDO o 9º
// dígito brasileiro: a Meta ora entrega o `from` com o 9 (5562 9xxxx...), ora
// sem (5562 xxxx...). Comparar exato deixaria o mesmo diretor "não autorizado"
// dependendo de como a mensagem chegou. `variantes()` gera as duas formas
// (com/sem 9, sempre com DDI 55) e casamos por qualquer uma delas.
async function autorizado(conn, telefone, numeroId) {
  try {
    const vs = variantes(telefone);
    const binds = { n: numeroId };
    const marks = vs.map((v, i) => { binds['t' + i] = v; return ':t' + i; });
    const r = await conn.execute(
      `SELECT COUNT(*) AS N FROM MC_ZAP_IA_AUTORIZADO
        WHERE TELEFONE IN (${marks.join(',')}) AND NUMERO_ID = :n AND ATIVO = 'S'`,
      binds);
    return (r.rows[0].N || 0) > 0;
  } catch (err) {
    if (err.errorNum === 942) return false;
    throw err;
  }
}

module.exports = { autorizado };
