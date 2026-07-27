// api/atendentes.js — Gestão de atendentes: papel, ativo e departamentos (Fase 5A).
// Leitura: ADMIN/SUPERVISOR. Escrita: ADMIN. Toda alteração vai pra AUDITORIA e
// invalida o cache do RBAC (efeito imediato sem o usuário relogar).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel, invalidar, PAPEIS } = require('../auth/rbac');
const presence = require('../realtime/presence');

const router = express.Router();

// GET /api/atendentes — lista com departamentos agregados (ADMIN/SUPERVISOR).
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT a.ID, a.MATRICULA, a.NOME, a.PAPEL, a.ATIVO, a.STATUS_PRESENCA, a.PODE_ATIVO,
              (SELECT LISTAGG(ad.DEPARTAMENTO_ID, ',') WITHIN GROUP (ORDER BY ad.DEPARTAMENTO_ID)
                 FROM MC_ZAP_ATENDENTE_DEPTO ad WHERE ad.ATENDENTE_ID = a.ID) AS DEPTO_IDS,
              (SELECT LISTAGG(an.NUMERO_ID, ',') WITHIN GROUP (ORDER BY an.NUMERO_ID)
                 FROM MC_ZAP_ATENDENTE_NUMERO an WHERE an.ATENDENTE_ID = a.ID) AS NUMERO_IDS
         FROM MC_ZAP_ATENDENTE a
        ORDER BY a.ATIVO DESC, a.NOME NULLS LAST`
    );
    const rows = mapRows(r.rows).map((a) => ({
      ...a,
      deptoIds: a.deptoIds ? a.deptoIds.split(',').map(Number) : [],
      numeroIds: a.numeroIds ? a.numeroIds.split(',').map(Number) : [],
    }));
    res.json(rows);
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// PUT /api/atendentes/:id — { papel?, ativo?, deptoIds?[] } (ADMIN).
router.put('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};
  if (b.papel && !PAPEIS.includes(b.papel)) {
    return res.status(400).json({ error: `Papel inválido (use: ${PAPEIS.join(', ')})` });
  }

  let conn;
  try {
    conn = await db.getConnection();
    const sel = await conn.execute(
      `SELECT MATRICULA, PAPEL, ATIVO FROM MC_ZAP_ATENDENTE WHERE ID = :id`, { id }
    );
    if (!sel.rows.length) return res.status(404).json({ error: 'Atendente não encontrado' });
    const matricula = sel.rows[0].MATRICULA;

    // Trava do ÚLTIMO admin: se a alteração rebaixa (papel != ADMIN) ou desativa
    // um ADMIN ativo e não sobra NENHUM outro admin ativo, recusa — senão ninguém
    // mais consegue administrar o sistema (e o force-promote de diretor foi removido).
    const eraAdminAtivo = sel.rows[0].PAPEL === 'ADMIN' && sel.rows[0].ATIVO !== 'N';
    const novoPapel = b.papel || sel.rows[0].PAPEL;
    const novoAtivo = (b.ativo === 'S' || b.ativo === 'N') ? b.ativo : sel.rows[0].ATIVO;
    const deixaDeSerAdminAtivo = !(novoPapel === 'ADMIN' && novoAtivo !== 'N');
    if (eraAdminAtivo && deixaDeSerAdminAtivo) {
      const outros = await conn.execute(
        `SELECT COUNT(*) AS QTD FROM MC_ZAP_ATENDENTE WHERE PAPEL = 'ADMIN' AND ATIVO = 'S' AND ID <> :id`,
        { id }
      );
      if (Number(outros.rows[0].QTD) === 0) {
        return res.status(400).json({ error: 'Este é o último ADMIN ativo. Promova outro atendente a ADMIN antes de rebaixar ou desativar este.' });
      }
    }

    await conn.execute(
      `UPDATE MC_ZAP_ATENDENTE
          SET PAPEL = COALESCE(:p, PAPEL),
              ATIVO = COALESCE(:a, ATIVO),
              PODE_ATIVO = COALESCE(:pa, PODE_ATIVO)
        WHERE ID = :id`,
      {
        p: b.papel || null,
        a: b.ativo === 'S' || b.ativo === 'N' ? b.ativo : null,
        pa: b.podeAtivo === 'S' || b.podeAtivo === 'N' ? b.podeAtivo : null,
        id,
      }
    );

    // Departamentos: substituição completa (DELETE + INSERT no N:N).
    if (Array.isArray(b.deptoIds)) {
      const ids = b.deptoIds.map(Number).filter(Number.isInteger);
      await conn.execute(`DELETE FROM MC_ZAP_ATENDENTE_DEPTO WHERE ATENDENTE_ID = :id`, { id });
      for (const dep of ids) {
        await conn.execute(
          `INSERT INTO MC_ZAP_ATENDENTE_DEPTO (ATENDENTE_ID, DEPARTAMENTO_ID) VALUES (:a, :d)`,
          { a: id, d: dep }
        );
      }
    }

    // Números (canais que atende): substituição completa. Lista vazia = TODOS.
    let numeroIds = null;
    if (Array.isArray(b.numeroIds)) {
      numeroIds = b.numeroIds.map(Number).filter(Number.isInteger);
      await conn.execute(`DELETE FROM MC_ZAP_ATENDENTE_NUMERO WHERE ATENDENTE_ID = :id`, { id });
      for (const n of numeroIds) {
        await conn.execute(
          `INSERT INTO MC_ZAP_ATENDENTE_NUMERO (ATENDENTE_ID, NUMERO_ID) VALUES (:a, :n)`,
          { a: id, n }
        );
      }
    }

    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:m, 'atendente_update', 'atendente', :id, :det)`,
      {
        m: req.user && req.user.matricula,
        id,
        det: JSON.stringify({ papel: b.papel, ativo: b.ativo, deptoIds: b.deptoIds, numeroIds: b.numeroIds }),
      }
    );
    await conn.commit();

    invalidar(matricula); // efeito imediato no RBAC
    // Sincroniza a presença em memória (se o atendente estiver online agora).
    presence.atualizarPerfil(id, {
      ...(Array.isArray(b.deptoIds) ? { deptoIds: b.deptoIds.map(Number).filter(Number.isInteger) } : {}),
      ...(numeroIds !== null ? { numeroIds } : {}),
    });
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err.errorNum === 2291) return res.status(400).json({ error: 'Departamento ou número inexistente' });
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
