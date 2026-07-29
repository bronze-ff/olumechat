// api/tags.js — Catálogo de tags/etiquetas (a atribuição por conversa fica na
// coluna JSON conversa.tags; aqui só o catálogo: listar e criar).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel } = require('../auth/rbac');
// FIL-85: as tags do tenant viraram o ENUM da ferramenta `aplicar_tag` da IA,
// com cache de 60s. Criar tag sem invalidar deixaria a IA um minuto sem
// conseguir usar a etiqueta que o gestor acabou de cadastrar.
const ferramentasStore = require('../ia/ferramentasStore');

const router = express.Router();

// GET /api/tags — lista todas as tags.
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(`SELECT id, nome, cor FROM tag ORDER BY nome`);
      return mapRows(r.rows);
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/tags — cria uma tag { nome, cor? }. Catálogo do tenant → só gestor cria.
router.post('/', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  const nome = String((req.body && req.body.nome) || '').trim();
  const cor = String((req.body && req.body.cor) || '').trim() || null;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  if (nome.length > 60) return res.status(400).json({ error: 'Nome muito longo (máx. 60)' });

  try {
    const id = await db.comTenant(req.tenantId, async (conn) => {
      const ins = await conn.execute(
        `INSERT INTO tag (nome, cor) VALUES (:n, :c) RETURNING id`,
        { n: nome, c: cor }
      );
      return ins.rows[0].ID;
    });
    ferramentasStore.invalidar(req.tenantId);
    res.status(201).json({ id, nome, cor });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma tag com esse nome' });
    next(err);
  }
});

module.exports = router;
