// server/ia/gate.js — gate do ADD-ON de IA (`tenant.ia_habilitada`).
//
// IA é vendida à parte (FIL-70): quem liga é o OPERADOR, em
// operador/tenants.js::definirIa — nunca o cliente. Toda rota que configura ou
// consome IA passa por aqui, server-side, não só escondendo botão na UI.
//
// ⚠️ Roda em transação PRÓPRIA e TERMINA antes de o handler abrir a dele —
// nunca duas conexões do pool presas pela mesma requisição (mesmo racional das
// 3 fases do ia/runtime.js). Extraído de api/iaPerfil.js na FIL-84, quando
// api/numeros.js passou a precisar do mesmo gate.
'use strict';

const db = require('../db/pool');

async function exigirIaHabilitada(req, res, next) {
  try {
    const habilitada = await db.comTenant(req.tenantId, async (conn) => {
      const t = await conn.execute(`SELECT ia_habilitada FROM tenant WHERE id = :tenantId`, { tenantId: req.tenantId });
      return (t.rows[0] || {}).IA_HABILITADA === 'S';
    });
    if (!habilitada) return res.status(400).json({ error: 'Recurso de IA não incluído no plano desta empresa.' });
    next();
  } catch (err) { next(err); }
}

module.exports = { exigirIaHabilitada };
