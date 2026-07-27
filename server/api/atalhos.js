// api/atalhos.js — Respostas rápidas ("/" no composer).
// Cada atendente cria os seus: escopo 'pessoal' (só ele vê) ou 'departamento'
// (todos os atendentes daquela fila veem). Excluir: só o criador ou ADMIN.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');

const router = express.Router();

async function lerClob(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : v.getData();
}

// GET /api/atalhos — meus pessoais + os dos meus departamentos (ADMIN vê tudo).
router.get('/', async (req, res, next) => {
  const perfil = req.perfil;
  let conn;
  try {
    conn = await db.getConnection();
    const conds = [];
    const binds = {};
    if (perfil.papel !== 'ADMIN') {
      const partes = [`(r.ESCOPO = 'pessoal' AND r.CRIADO_POR = :meuId)`];
      binds.meuId = perfil.atendenteId;
      if (perfil.deptoIds.length) {
        const ms = perfil.deptoIds.map((d, i) => { binds[`dep${i}`] = d; return `:dep${i}`; });
        partes.push(`(r.ESCOPO = 'departamento' AND r.DEPARTAMENTO_ID IN (${ms.join(',')}))`);
      }
      conds.push(`(${partes.join(' OR ')})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await conn.execute(
      `SELECT r.ID, r.ATALHO, r.TITULO, r.CONTEUDO, r.ESCOPO, r.DEPARTAMENTO_ID, r.CRIADO_POR,
              d.NOME AS DEPARTAMENTO_NOME
         FROM MC_ZAP_RESPOSTA_RAPIDA r
         LEFT JOIN MC_ZAP_DEPARTAMENTO d ON d.ID = r.DEPARTAMENTO_ID
        ${where}
        ORDER BY r.ATALHO`,
      binds
    );
    const rows = [];
    for (const row of mapRows(r.rows)) {
      rows.push({
        ...row,
        conteudo: await lerClob(row.conteudo),
        meu: row.criadoPor === perfil.atendenteId,
      });
    }
    res.json(rows);
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
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

  let conn;
  try {
    conn = await db.getConnection();
    const { tipos } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_RESPOSTA_RAPIDA (ATALHO, TITULO, CONTEUDO, ESCOPO, DEPARTAMENTO_ID, CRIADO_POR)
       VALUES (:a, :t, :c, :e, :d, :por) RETURNING ID INTO :id`,
      {
        a: atalho,
        t: b.titulo ? String(b.titulo).trim().slice(0, 120) : null,
        c: conteudo,
        e: escopo, d: departamentoId, por: perfil.atendenteId,
        id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
      }
    );
    await conn.commit();
    res.status(201).json({ id: ins.outBinds.id[0], atalho });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// DELETE /api/atalhos/:id — só o criador ou ADMIN.
router.delete('/:id', async (req, res, next) => {
  const perfil = req.perfil;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const guarda = perfil.papel === 'ADMIN' ? '' : 'AND CRIADO_POR = :por';
    const del = await conn.execute(
      `DELETE FROM MC_ZAP_RESPOSTA_RAPIDA WHERE ID = :id ${guarda}`,
      perfil.papel === 'ADMIN' ? { id } : { id, por: perfil.atendenteId }
    );
    if (!del.rowsAffected) return res.status(403).json({ error: 'Só quem criou (ou ADMIN) pode excluir' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
