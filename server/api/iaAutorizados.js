// api/iaAutorizados.js — telefones autorizados a falar com o bot de IA (ADMIN).
// FIL-63: escopado por req.tenantId via db.comTenant() (ver api/iaConfig.js).
'use strict';
const express = require('express');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const { normalizar } = require('../utils/telefone');

const router = express.Router();

router.get('/', exigirPapel('ADMIN'), async (req, res, next) => {
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT ID, TELEFONE, NOME, NUMERO_ID, ATIVO FROM ia_autorizado
          WHERE tenant_id = :tenantId AND (:num IS NULL OR NUMERO_ID = :num) ORDER BY NOME`,
        { tenantId: req.tenantId, num: req.query.numeroId ? Number(req.query.numeroId) : null });
      return r.rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', exigirPapel('ADMIN'), async (req, res, next) => {
  // Normaliza com DDI 55 (números BR de 10/11 dígitos) para casar com o formato
  // que o webhook entrega. A tolerância ao 9º dígito fica na hora de comparar
  // (ia/autorizacao.js usa variantes()); aqui só garantimos o DDI.
  const telefone = normalizar(req.body && req.body.telefone);
  const numeroId = Number(req.body && req.body.numeroId);
  const nome = (req.body && req.body.nome) || null;
  if (!telefone) return res.status(400).json({ error: 'Telefone obrigatório' });
  if (!Number.isInteger(numeroId)) return res.status(400).json({ error: 'numeroId inválido' });
  try {
    await db.comTenant(req.tenantId, async (conn) => {
      await conn.execute(
        `INSERT INTO ia_autorizado (tenant_id, TELEFONE, NOME, NUMERO_ID, ATIVO)
         VALUES (:tenantId, :t, :nm, :n, 'S')
         ON CONFLICT (tenant_id, TELEFONE, NUMERO_ID) DO UPDATE SET ATIVO = 'S', NOME = EXCLUDED.NOME`,
        { tenantId: req.tenantId, t: telefone, nm: nome, n: numeroId });
      await conn.execute(
        `INSERT INTO auditoria (tenant_id, ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, DETALHE)
         VALUES (:tenantId, :atd, :mat, 'ia_autorizado_add', 'ia_autorizado', :det)`,
        { tenantId: req.tenantId, atd: req.perfil && req.perfil.atendenteId, mat: req.user && req.user.matricula, det: JSON.stringify({ telefone, numeroId }) });
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    await db.comTenant(req.tenantId, async (conn) => {
      await conn.execute(`UPDATE ia_autorizado SET ATIVO='N' WHERE tenant_id = :tenantId AND ID = :id`, { tenantId: req.tenantId, id });
      await conn.execute(
        `INSERT INTO auditoria (tenant_id, ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID)
         VALUES (:tenantId, :atd, :mat, 'ia_autorizado_off', 'ia_autorizado', :id)`,
        { tenantId: req.tenantId, atd: req.perfil && req.perfil.atendenteId, mat: req.user && req.user.matricula, id });
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
