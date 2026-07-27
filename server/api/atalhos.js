// api/atalhos.js — Respostas rápidas ("/" no composer).
// Cada atendente cria os seus: escopo 'pessoal' (só ele vê) ou 'departamento'
// (todos os atendentes daquela fila veem). Excluir: só o criador ou ADMIN.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');

const router = express.Router();

// GET /api/atalhos — meus pessoais + os dos meus departamentos (ADMIN vê tudo).
router.get('/', async (req, res, next) => {
  const perfil = req.perfil;
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const conds = [];
      const binds = {};
      if (perfil.papel !== 'ADMIN') {
        const partes = [`(r.escopo = 'pessoal' AND r.criado_por = :meuId)`];
        binds.meuId = perfil.atendenteId;
        if (perfil.deptoIds.length) {
          const ms = perfil.deptoIds.map((d, i) => { binds[`dep${i}`] = d; return `:dep${i}`; });
          partes.push(`(r.escopo = 'departamento' AND r.departamento_id IN (${ms.join(',')}))`);
        }
        conds.push(`(${partes.join(' OR ')})`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const r = await conn.execute(
        `SELECT r.id, r.atalho, r.titulo, r.conteudo, r.escopo, r.departamento_id, r.criado_por,
                d.nome AS departamento_nome
           FROM resposta_rapida r
           LEFT JOIN departamento d ON d.id = r.departamento_id
          ${where}
          ORDER BY r.atalho`,
        binds
      );
      return mapRows(r.rows);
    });
    res.json(rows.map((row) => ({ ...row, meu: row.criadoPor === perfil.atendenteId })));
  } catch (err) {
    next(err);
  }
});

// POST /api/atalhos — { atalho, titulo?, conteudo, escopo, departamentoId? }.
router.post('/', async (req, res, next) => {
  const perfil = req.perfil;
  const b = req.body || {};
  const atalho = String(b.atalho || '').trim().toLowerCase().replace(/^\//, '').replace(/\s+/g, '-').slice(0, 40);
  const conteudo = String(b.conteudo || '').trim();
  const escopo = b.escopo === 'departamento' ? 'departamento' : 'pessoal';
  const departamentoId = escopo === 'departamento' ? Number(b.departamentoId) : null;

  if (!atalho) return res.status(400).json({ error: 'Defina o atalho (ex.: sem-credito)' });
  if (!conteudo) return res.status(400).json({ error: 'Escreva o conteúdo da resposta' });
  if (escopo === 'departamento') {
    if (!departamentoId) return res.status(400).json({ error: 'Escolha o departamento' });
    // Só pode publicar em departamento que ele atende (ADMIN publica em qualquer).
    if (perfil.papel !== 'ADMIN' && !perfil.deptoIds.includes(departamentoId)) {
      return res.status(403).json({ error: 'Você não atende esse departamento' });
    }
  }

  try {
    const id = await db.comTenant(req.tenantId, async (conn) => {
      const ins = await conn.execute(
        `INSERT INTO resposta_rapida (atalho, titulo, conteudo, escopo, departamento_id, criado_por)
         VALUES (:a, :t, :c, :e, :d, :por) RETURNING id`,
        {
          a: atalho,
          t: b.titulo ? String(b.titulo).trim().slice(0, 120) : null,
          c: conteudo,
          e: escopo, d: departamentoId, por: perfil.atendenteId,
        }
      );
      return ins.rows[0].ID;
    });
    res.status(201).json({ id, atalho });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/atalhos/:id — só o criador ou ADMIN.
router.delete('/:id', async (req, res, next) => {
  const perfil = req.perfil;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const apagou = await db.comTenant(req.tenantId, async (conn) => {
      const guarda = perfil.papel === 'ADMIN' ? '' : 'AND criado_por = :por';
      const del = await conn.execute(
        `DELETE FROM resposta_rapida WHERE id = :id ${guarda}`,
        perfil.papel === 'ADMIN' ? { id } : { id, por: perfil.atendenteId }
      );
      return del.rowsAffected > 0;
    });
    if (!apagou) return res.status(403).json({ error: 'Só quem criou (ou ADMIN) pode excluir' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
