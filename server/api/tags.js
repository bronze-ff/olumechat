// api/tags.js — Catálogo de tags/etiquetas (a atribuição por conversa fica na
// coluna JSON MC_ZAP_CONVERSA.TAGS; aqui só o catálogo: listar e criar).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel } = require('../auth/rbac');

const router = express.Router();

// GET /api/tags — lista todas as tags.
router.get('/', async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT ID, NOME, COR FROM MC_ZAP_TAG ORDER BY NOME`);
    res.json(mapRows(r.rows));
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/tags — cria uma tag { nome, cor? }. Catálogo global → só gestor cria.
router.post('/', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  const nome = String((req.body && req.body.nome) || '').trim();
  const cor = String((req.body && req.body.cor) || '').trim() || null;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  if (nome.length > 60) return res.status(400).json({ error: 'Nome muito longo (máx. 60)' });

  let conn;
  try {
    conn = await db.getConnection();
    const { tipos } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_TAG (NOME, COR) VALUES (:n, :c) RETURNING ID INTO :id`,
      { n: nome, c: cor, id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
    );
    await conn.commit();
    res.status(201).json({ id: ins.outBinds.id[0], nome, cor });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err.errorNum === 1) return res.status(409).json({ error: 'Já existe uma tag com esse nome' });
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
