// api/iaConfig.js — status do provedor de IA do tenant (1 linha em ia_config).
// SOMENTE LEITURA a partir daqui: IA é add-on vendido à parte — quem define
// provider/modelo/chave é o OPERADOR (operador/tenants.js::salvarIaConfig,
// via /api/operador/tenants/:id/ia-config), não o admin do cliente. O admin
// só vê se o recurso está incluído no plano (`habilitada`) e, se estiver, qual
// provedor/modelo está em uso — nunca a chave.
'use strict';
const express = require('express');
const db = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const out = await db.comTenant(req.tenantId, async (conn) => {
      const t = await conn.execute(`SELECT ia_habilitada FROM tenant WHERE id = :tenantId`, { tenantId: req.tenantId });
      const habilitada = (t.rows[0] || {}).IA_HABILITADA === 'S';
      const r = await conn.execute(
        `SELECT PROVIDER, MODELO, BASE_URL, ATIVO, ATUALIZADO_EM FROM ia_config
          WHERE tenant_id = :tenantId AND ID = 1`,
        { tenantId: req.tenantId });
      const row = (r.rows && r.rows[0]) || null;
      return {
        habilitada,
        provider: row ? row.PROVIDER : null,
        modelo: row ? row.MODELO : null,
        baseUrl: row ? row.BASE_URL : null,
        ativo: row ? row.ATIVO === 'S' : false,
        atualizadoEm: row ? row.ATUALIZADO_EM : null,
      };
    });
    res.json(out);
  } catch (err) {
    if (err.code === '42P01') return res.json({ habilitada: false, provider: null, modelo: null, baseUrl: null, ativo: false });
    next(err);
  }
});

module.exports = router;
