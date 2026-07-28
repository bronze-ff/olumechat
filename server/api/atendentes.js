// api/atendentes.js — Gestão de atendentes: papel, ativo e departamentos (Fase 5A).
// Leitura: ADMIN/SUPERVISOR. Escrita: ADMIN. Toda alteração vai pra AUDITORIA e
// invalida o cache do RBAC (efeito imediato sem o usuário relogar).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel, invalidar, PAPEIS } = require('../auth/rbac');
const presence = require('../realtime/presence');
const tokenSenha = require('../auth/tokenSenha');
const { linkDeConvite } = require('../utils/conviteLink');

const router = express.Router();

/** Erro de negócio com status HTTP — evita `next(err)` genérico p/ 4xx esperados. */
class ErroValidacao extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

// GET /api/atendentes — lista com departamentos agregados (ADMIN/SUPERVISOR/AUDITOR).
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
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

// POST /api/atendentes — cria usuário + atendente (ADMIN). Ninguém digita a
// senha por ele: o admin cadastra e-mail/papel/departamentos e o sistema
// devolve um LINK de definir-senha de uso único (mesmo fluxo/tela do convite
// que o operador usa pra criar o primeiro admin — client/DefinirSenha.jsx).
// O admin copia o link e envia pelo canal que preferir (nada de e-mail
// automático ainda, ver operador/routes.js).
router.post('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const nome = b.nome ? String(b.nome).trim().slice(0, 120) : null;
  const papel = b.papel || 'ATENDENTE';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 160) {
    return res.status(400).json({ error: 'Informe um e-mail válido.' });
  }
  if (!PAPEIS.includes(papel)) {
    return res.status(400).json({ error: `Papel inválido (use: ${PAPEIS.join(', ')})` });
  }
  const deptoIds = Array.isArray(b.deptoIds) ? b.deptoIds.map(Number).filter(Number.isInteger) : [];
  const numeroIds = Array.isArray(b.numeroIds) ? b.numeroIds.map(Number).filter(Number.isInteger) : [];
  // ADMIN sempre pode disparo ativo (mesma regra do PUT/Atendentes.jsx).
  const podeAtivo = papel === 'ADMIN' ? 'S' : (b.podeAtivo === 'S' ? 'S' : 'N');

  try {
    const criado = await db.comTenant(req.tenantId, async (conn) => {
      let usuarioId;
      try {
        const ins = await conn.execute(
          `INSERT INTO usuario (tenant_id, email, nome) VALUES (:tenantId, :email, :nome) RETURNING id`,
          { tenantId: req.tenantId, email, nome }
        );
        usuarioId = Number(ins.rows[0].ID);
      } catch (err) {
        if (err.code === '23505') throw new ErroValidacao(409, 'Já existe um usuário com esse e-mail.');
        throw err;
      }
      const insAtd = await conn.execute(
        `INSERT INTO atendente (tenant_id, matricula, nome, papel, pode_ativo)
         VALUES (:tenantId, :matricula, :nome, :papel, :pa) RETURNING id`,
        { tenantId: req.tenantId, matricula: usuarioId, nome, papel, pa: podeAtivo }
      );
      const atendenteId = Number(insAtd.rows[0].ID);

      for (const dep of deptoIds) {
        await conn.execute(
          `INSERT INTO atendente_depto (atendente_id, departamento_id) VALUES (:a, :d)`,
          { a: atendenteId, d: dep }
        );
      }
      for (const n of numeroIds) {
        await conn.execute(
          `INSERT INTO atendente_numero (atendente_id, numero_id) VALUES (:a, :n)`,
          { a: atendenteId, n }
        );
      }

      // O link do convite precisa do slug (é a "empresa" que a tela de definir
      // senha usa pra resolver o tenant) — tenant_proprio (id = tenant_atual())
      // deixa este SELECT passar mesmo dentro de comTenant().
      const t = await conn.execute(`SELECT slug FROM tenant WHERE id = :id`, { id: req.tenantId });

      await conn.execute(
        `INSERT INTO auditoria (matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:m, 'atendente_criado', 'atendente', :id, :det)`,
        { m: req.user && req.user.matricula, id: atendenteId, det: JSON.stringify({ email, papel, deptoIds, numeroIds }) }
      );

      return { usuarioId, atendenteId, slug: t.rows[0] && t.rows[0].SLUG };
    });

    const convite = await tokenSenha.gerarToken(req.tenantId, criado.usuarioId);
    res.status(201).json({
      id: criado.atendenteId,
      convite: { link: linkDeConvite(criado.slug, convite.token), expiraEm: convite.expiraEm.toISOString() },
    });
  } catch (err) {
    if (err instanceof ErroValidacao) return res.status(err.status).json({ error: err.message });
    if (err.code === '23503') return res.status(400).json({ error: 'Departamento ou número inexistente' });
    next(err);
  }
});

// POST /api/atendentes/:id/resetar-senha — gera um NOVO link de definir senha
// (ADMIN). tokenSenha.gerarToken já invalida qualquer link anterior ainda não
// usado daquele usuário — "resetar" é só emitir um convite novo.
router.post('/:id/resetar-senha', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const dados = await db.comTenant(req.tenantId, async (conn) => {
      const sel = await conn.execute(`SELECT matricula FROM atendente WHERE id = :id`, { id });
      if (!sel.rows.length) return null;
      const t = await conn.execute(`SELECT slug FROM tenant WHERE id = :tid`, { tid: req.tenantId });
      return { usuarioId: Number(sel.rows[0].MATRICULA), slug: t.rows[0] && t.rows[0].SLUG };
    });
    if (!dados) return res.status(404).json({ error: 'Atendente não encontrado' });

    const convite = await tokenSenha.gerarToken(req.tenantId, dados.usuarioId);
    await db.comTenant(req.tenantId, (conn) => conn.execute(
      `INSERT INTO auditoria (matricula, acao, entidade, entidade_id, detalhe)
       VALUES (:m, 'senha_resetada', 'atendente', :id, '{}')`,
      { m: req.user && req.user.matricula, id }
    ));
    res.json({ convite: { link: linkDeConvite(dados.slug, convite.token), expiraEm: convite.expiraEm.toISOString() } });
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

      // "Remover" precisa bloquear o LOGIN de verdade, não só a operação —
      // atendente.ativo por si só não impede entrar (quem barra login é
      // usuario.ativo, ver auth/routes.js). matricula = usuario.id (migração 004).
      if (b.ativo === 'S' || b.ativo === 'N') {
        await conn.execute(
          `UPDATE usuario SET ativo = :a WHERE tenant_id = :tenantId AND id = :uid`,
          { a: b.ativo, tenantId: req.tenantId, uid: matricula }
        );
      }

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
