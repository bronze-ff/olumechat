// api/iaAutorizados.js — telefones autorizados a falar com o bot de IA (ADMIN).
'use strict';
const express = require('express');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const { normalizar } = require('../utils/telefone');

const router = express.Router();

router.get('/', exigirPapel('ADMIN'), async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT ID, TELEFONE, NOME, NUMERO_ID, ATIVO FROM MC_ZAP_IA_AUTORIZADO
        WHERE (:num IS NULL OR NUMERO_ID = :num) ORDER BY NOME`, { num: req.query.numeroId ? Number(req.query.numeroId) : null });
    res.json(r.rows);
  } catch (err) { next(err); } finally { if (conn) await conn.close().catch(() => {}); }
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
  let conn;
  try {
    conn = await db.getConnection();
    await conn.execute(
      `MERGE INTO MC_ZAP_IA_AUTORIZADO a USING (SELECT :t AS TEL, :n AS NUM FROM DUAL) x
          ON (a.TELEFONE = x.TEL AND a.NUMERO_ID = x.NUM)
        WHEN MATCHED THEN UPDATE SET a.ATIVO='S', a.NOME=:nm
        WHEN NOT MATCHED THEN INSERT (TELEFONE, NOME, NUMERO_ID, ATIVO) VALUES (:t2, :nm2, :n2, 'S')`,
      { t: telefone, n: numeroId, nm: nome, t2: telefone, nm2: nome, n2: numeroId });
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, DETALHE)
       VALUES (:atd, :mat, 'ia_autorizado_add', 'ia_autorizado', :det)`,
      { atd: req.perfil && req.perfil.atendenteId, mat: req.user && req.user.matricula, det: JSON.stringify({ telefone, numeroId }) });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { if (conn) await conn.rollback().catch(() => {}); next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

router.delete('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    await conn.execute(`UPDATE MC_ZAP_IA_AUTORIZADO SET ATIVO='N' WHERE ID = :id`, { id });
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID)
       VALUES (:atd, :mat, 'ia_autorizado_off', 'ia_autorizado', :id)`,
      { atd: req.perfil && req.perfil.atendenteId, mat: req.user && req.user.matricula, id });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { if (conn) await conn.rollback().catch(() => {}); next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

module.exports = router;
