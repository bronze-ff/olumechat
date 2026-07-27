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
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT a.id, a.matricula, a.nome, a.papel, a.ativo, a.status_presenca, a.pode_ativo,
                (SELECT STRING_AGG(ad.departamento_id::text, ',' ORDER BY ad.departamento_id)
                   FROM atendente_depto ad WHERE ad.atendente_id = a.id) AS depto_ids,
                (SELECT STRING_AGG(an.numero_id::text, ',' ORDER BY an.numero_id)
                   FROM atendente_numero an WHERE an.atendente_id = a.id) AS numero_ids
           FROM atendente a
          ORDER BY a.ativo DESC, a.nome NULLS LAST`
      );
      return mapRows(r.rows);
    });
    const out = rows.map((a) => ({
      ...a,
      deptoIds: a.deptoIds ? a.deptoIds.split(',').map(Number) : [],
      numeroIds: a.numeroIds ? a.numeroIds.split(',').map(Number) : [],
    }));
    res.json(out);
  } catch (err) {
    next(err);
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

  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      const sel = await conn.execute(
        `SELECT matricula, papel, ativo FROM atendente WHERE id = :id`, { id }
      );
      if (!sel.rows.length) return { naoEncontrado: true };
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
          `SELECT COUNT(*) AS qtd FROM atendente WHERE papel = 'ADMIN' AND ativo = 'S' AND id <> :id`,
          { id }
        );
        if (Number(outros.rows[0].QTD) === 0) {
          return { ultimoAdmin: true };
        }
      }

      await conn.execute(
        `UPDATE atendente
            SET papel = COALESCE(:p, papel),
                ativo = COALESCE(:a, ativo),
                pode_ativo = COALESCE(:pa, pode_ativo)
          WHERE id = :id`,
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
        await conn.execute(`DELETE FROM atendente_depto WHERE atendente_id = :id`, { id });
        for (const dep of ids) {
          await conn.execute(
            `INSERT INTO atendente_depto (atendente_id, departamento_id) VALUES (:a, :d)`,
            { a: id, d: dep }
          );
        }
      }

      // Números (canais que atende): substituição completa. Lista vazia = TODOS.
      let numeroIds = null;
      if (Array.isArray(b.numeroIds)) {
        numeroIds = b.numeroIds.map(Number).filter(Number.isInteger);
        await conn.execute(`DELETE FROM atendente_numero WHERE atendente_id = :id`, { id });
        for (const n of numeroIds) {
          await conn.execute(
            `INSERT INTO atendente_numero (atendente_id, numero_id) VALUES (:a, :n)`,
            { a: id, n }
          );
        }
      }

      await conn.execute(
        `INSERT INTO auditoria (matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:m, 'atendente_update', 'atendente', :id, :det)`,
        {
          m: req.user && req.user.matricula,
          id,
          det: JSON.stringify({ papel: b.papel, ativo: b.ativo, deptoIds: b.deptoIds, numeroIds: b.numeroIds }),
        }
      );

      return { matricula, numeroIds };
    });

    if (resultado.naoEncontrado) return res.status(404).json({ error: 'Atendente não encontrado' });
    if (resultado.ultimoAdmin) {
      return res.status(400).json({ error: 'Este é o último ADMIN ativo. Promova outro atendente a ADMIN antes de rebaixar ou desativar este.' });
    }

    invalidar(resultado.matricula); // efeito imediato no RBAC
    // Sincroniza a presença em memória (se o atendente estiver online agora).
    presence.atualizarPerfil(id, {
      ...(Array.isArray(b.deptoIds) ? { deptoIds: b.deptoIds.map(Number).filter(Number.isInteger) } : {}),
      ...(resultado.numeroIds !== null ? { numeroIds: resultado.numeroIds } : {}),
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'Departamento ou número inexistente' });
    next(err);
  }
});

module.exports = router;
