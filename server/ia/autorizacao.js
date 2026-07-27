'use strict';

const { variantes } = require('../utils/telefone');

// Casa o telefone do remetente contra a lista de autorizados TOLERANDO o 9º
// dígito brasileiro: a Meta ora entrega o `from` com o 9 (5562 9xxxx...), ora
// sem (5562 xxxx...). Comparar exato deixaria o mesmo diretor "não autorizado"
// dependendo de como a mensagem chegou. `variantes()` gera as duas formas
// (com/sem 9, sempre com DDI 55) e casamos por qualquer uma delas.
async function autorizado(conn, tenantId, telefone, numeroId) {
  try {
    const vs = variantes(telefone);
    const binds = { tenantId, n: numeroId };
    const marks = vs.map((v, i) => { binds['t' + i] = v; return ':t' + i; });
    const r = await conn.execute(
      `SELECT COUNT(*) AS N FROM ia_autorizado
        WHERE tenant_id = :tenantId AND TELEFONE IN (${marks.join(',')}) AND NUMERO_ID = :n AND ATIVO = 'S'`,
      binds);
    return (r.rows[0].N || 0) > 0;
  } catch (err) {
    if (err.code === '42P01') return false; // tabela ainda não criada (undefined_table)
    throw err;
  }
}

module.exports = { autorizado };
