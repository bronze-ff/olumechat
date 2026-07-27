// api/departamentos.js — CRUD de departamentos/equipes (Fase 5A).
// Leitura: qualquer autenticado (o front precisa pra montar filtros/transferência).
// Escrita: ADMIN. Desativação é lógica (ATIVO='N') — nunca apaga (FKs/histórico).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel } = require('../auth/rbac');

const router = express.Router();

// GET /api/departamentos — lista (ativos primeiro). ?todos=1 inclui inativos.
router.get('/', async (req, res, next) => {
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const where = req.query.todos ? '' : `WHERE d.ativo = 'S'`;
      const r = await conn.execute(
        `SELECT d.id, d.nome, d.descricao, d.cor, d.ativo,
                (SELECT COUNT(*) FROM atendente_depto ad WHERE ad.departamento_id = d.id) AS qtd_atendentes
           FROM departamento d ${where}
          ORDER BY d.ativo DESC, d.nome`
      );
      return mapRows(r.rows);
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/departamentos — cria { nome, descricao?, cor? } (ADMIN).
router.post('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const nome = String((req.body && req.body.nome) || '').trim();
  const descricao = String((req.body && req.body.descricao) || '').trim() || null;
  const cor = String((req.body && req.body.cor) || '').trim() || null;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  if (nome.length > 80) return res.status(400).json({ error: 'Nome muito longo (máx. 80)' });

  try {
    const id = await db.comTenant(req.tenantId, async (conn) => {
      const ins = await conn.execute(
        `INSERT INTO departamento (nome, descricao, cor) VALUES (:n, :d, :c) RETURNING id`,
        { n: nome, d: descricao, c: cor }
      );
      return ins.rows[0].ID;
    });
    res.status(201).json({ id, nome, descricao, cor, ativo: 'S' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um departamento com esse nome' });
    next(err);
  }
});

// PUT /api/departamentos/:id — atualiza { nome?, descricao?, cor?, ativo? } (ADMIN).
router.put('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};

  try {
    const atualizou = await db.comTenant(req.tenantId, async (conn) => {
      const upd = await conn.execute(
        `UPDATE departamento
            SET nome      = COALESCE(:n, nome),
                descricao = COALESCE(:d, descricao),
                cor       = COALESCE(:c, cor),
                ativo     = COALESCE(:a, ativo)
          WHERE id = :id`,
        {
          n: b.nome ? String(b.nome).trim() : null,
          d: b.descricao !== undefined ? String(b.descricao).trim() : null,
          c: b.cor ? String(b.cor).trim() : null,
          a: b.ativo === 'S' || b.ativo === 'N' ? b.ativo : null,
          id,
        }
      );
      return upd.rowsAffected > 0;
    });
    if (!atualizou) return res.status(404).json({ error: 'Departamento não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um departamento com esse nome' });
    next(err);
  }
});

module.exports = router;
