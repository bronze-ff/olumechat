// api/iaConfig.js — status do provedor de IA do tenant. SOMENTE LEITURA a
// partir daqui: IA é add-on vendido à parte — quem define provider/modelo/
// chave é o OPERADOR (operador/tenants.js::salvarIaConfig, ou a credencial
// GLOBAL em operador/credencialIa.js, FIL-78), não o admin do cliente.
//
// FIL-78 (achado de review, P1): a maioria dos tenants HOJE não tem chave
// própria — usam a credencial global do operador (ia/iaConfigStore.js). Sem
// isto, `ativo` sempre voltava false pra eles e a tela dizia "não
// configurado" mesmo com a IA funcionando de verdade. `ativo`/`origem` agora
// refletem a credencial EFETIVA (própria ou global) — mas só a chave própria
// do tenant expõe provider/modelo/baseUrl: a credencial global não devolve
// NENHUM detalhe (nem provedor, nem modelo, nem mascarado) por nenhuma rota
// de tenant, só "está configurada" ou não.
'use strict';
const express = require('express');
const db = require('../db/pool');
const iaConfigStore = require('../ia/iaConfigStore');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { habilitada, row } = await db.comTenant(req.tenantId, async (conn) => {
      const t = await conn.execute(`SELECT ia_habilitada FROM tenant WHERE id = :tenantId`, { tenantId: req.tenantId });
      const habilitada = (t.rows[0] || {}).IA_HABILITADA === 'S';
      const r = await conn.execute(
        `SELECT PROVIDER, MODELO, BASE_URL, ATIVO, ATUALIZADO_EM FROM ia_config
          WHERE tenant_id = :tenantId AND ID = 1`,
        { tenantId: req.tenantId });
      return { habilitada, row: (r.rows && r.rows[0]) || null };
    });

    if (row && row.ATIVO === 'S') {
      return res.json({
        habilitada, ativo: true, origem: 'tenant',
        provider: row.PROVIDER, modelo: row.MODELO, baseUrl: row.BASE_URL,
        atualizadoEm: row.ATUALIZADO_EM,
      });
    }

    // Sem chave própria ativa: pode estar rodando na credencial GLOBAL do
    // operador. Resolvida FORA da transação de tenant acima (iaConfigStore
    // abre a própria transação de operador — nunca aninha com a de tenant,
    // ver ia/iaConfigStore.js) e só para saber SE existe, nunca qual é.
    const global = habilitada ? await iaConfigStore.carregar(req.tenantId) : null;
    res.json({
      habilitada, ativo: !!global, origem: global ? 'operador' : null,
      provider: null, modelo: null, baseUrl: null, atualizadoEm: null,
    });
  } catch (err) {
    if (err.code === '42P01') return res.json({ habilitada: false, ativo: false, origem: null, provider: null, modelo: null, baseUrl: null, atualizadoEm: null });
    next(err);
  }
});

module.exports = router;
