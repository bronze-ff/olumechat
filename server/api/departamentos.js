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
  let conn;
  try {
    conn = await db.getConnection();
    const where = req.query.todos ? '' : `WHERE ATIVO = 'S'`;
    const r = await conn.execute(
      `SELECT ID, NOME, DESCRICAO, COR, ATIVO,
              (SELECT COUNT(*) FROM MC_ZAP_ATENDENTE_DEPTO ad WHERE ad.DEPARTAMENTO_ID = d.ID) AS QTD_ATENDENTES
         FROM MC_ZAP_DEPARTAMENTO d ${where}
        ORDER BY ATIVO DESC, NOME`
    );
    res.json(mapRows(r.rows));
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/departamentos — cria { nome, descricao?, cor? } (ADMIN).
router.post('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const nome = String((req.body && req.body.nome) || '').trim();
  const descricao = String((req.body && req.body.descricao) || '').trim() || null;
  const cor = String((req.body && req.body.cor) || '').trim() || null;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  if (nome.length > 80) return res.status(400).json({ error: 'Nome muito longo (máx. 80)' });

  let conn;
  try {
    conn = await db.getConnection();
    const { tipos } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_DEPARTAMENTO (NOME, DESCRICAO, COR)
       VALUES (:n, :d, :c) RETURNING ID INTO :id`,
      { n: nome, d: descricao, c: cor, id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
    );
    await conn.commit();
    res.status(201).json({ id: ins.outBinds.id[0], nome, descricao, cor, ativo: 'S' });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err.errorNum === 1) return res.status(409).json({ error: 'Já existe um departamento com esse nome' });
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// PUT /api/departamentos/:id — atualiza { nome?, descricao?, cor?, ativo? } (ADMIN).
router.put('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};

  let conn;
  try {
    conn = await db.getConnection();
    const upd = await conn.execute(
      `UPDATE MC_ZAP_DEPARTAMENTO
          SET NOME      = COALESCE(:n, NOME),
              DESCRICAO = COALESCE(:d, DESCRICAO),
              COR       = COALESCE(:c, COR),
              ATIVO     = COALESCE(:a, ATIVO)
        WHERE ID = :id`,
      {
        n: b.nome ? String(b.nome).trim() : null,
        d: b.descricao !== undefined ? String(b.descricao).trim() : null,
        c: b.cor ? String(b.cor).trim() : null,
        a: b.ativo === 'S' || b.ativo === 'N' ? b.ativo : null,
        id,
      }
    );
    if (!upd.rowsAffected) return res.status(404).json({ error: 'Departamento não encontrado' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err.errorNum === 1) return res.status(409).json({ error: 'Já existe um departamento com esse nome' });
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
