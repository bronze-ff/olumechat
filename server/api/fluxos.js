// api/fluxos.js — CRUD dos fluxos do chatbot (Fase 5C).
// Leitura: ADMIN/SUPERVISOR. Escrita/ativação: ADMIN.
// POST /simular roda o engine puro (alimenta o preview do editor, sem WhatsApp).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel } = require('../auth/rbac');
const engine = require('../bot/engine');

const router = express.Router();

async function lerClob(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : v.getData();
}

// GET /api/fluxos — lista (sem a definição, que pode ser grande).
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT f.ID, f.NOME, f.NUMERO_ID, f.ATIVO, f.VERSAO, f.CRIADO_EM, f.ATUALIZADO_EM,
              n.DISPLAY_PHONE, n.NOME_EXIBICAO
         FROM MC_ZAP_FLUXO f
         LEFT JOIN MC_ZAP_NUMERO n ON n.ID = f.NUMERO_ID
        ORDER BY f.ATIVO DESC, f.NOME`
    );
    res.json(mapRows(r.rows));
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/fluxos/:id — com a definição completa.
router.get('/:id', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT ID, NOME, NUMERO_ID, ATIVO, VERSAO, DEFINICAO FROM MC_ZAP_FLUXO WHERE ID = :id`,
      { id }
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Fluxo não encontrado' });
    const row = r.rows[0];
    const def = await lerClob(row.DEFINICAO);
    res.json({
      id: row.ID, nome: row.NOME, numeroId: row.NUMERO_ID, ativo: row.ATIVO,
      versao: row.VERSAO, definicao: JSON.parse(def),
    });
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/fluxos — cria { nome, numeroId?, definicao } (rascunho, ATIVO='N').
router.post('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const erros = engine.validarFluxo(b.definicao);
  if (erros.length) return res.status(400).json({ error: 'Fluxo inválido', detalhes: erros });

  let conn;
  try {
    conn = await db.getConnection();
    const { tipos } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_FLUXO (NOME, NUMERO_ID, DEFINICAO)
       VALUES (:n, :num, :def) RETURNING ID INTO :id`,
      {
        n: nome, num: b.numeroId ? Number(b.numeroId) : null,
        def: JSON.stringify(b.definicao),
        id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
      }
    );
    await conn.commit();
    res.status(201).json({ id: ins.outBinds.id[0] });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// PUT /api/fluxos/:id — atualiza { nome?, numeroId?, definicao? } (bump VERSAO).
router.put('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};
  if (b.definicao) {
    const erros = engine.validarFluxo(b.definicao);
    if (erros.length) return res.status(400).json({ error: 'Fluxo inválido', detalhes: erros });
  }

  let conn;
  try {
    conn = await db.getConnection();
    // SET dinâmico: NUNCA usar COALESCE com a coluna CLOB (DEFINICAO) — o bind
    // chega como VARCHAR2 e o Oracle rejeita misturar os tipos (ORA-00932).
    const sets = ['VERSAO = VERSAO + 1', 'ATUALIZADO_EM = SYSTIMESTAMP'];
    const binds = { id };
    if (b.nome) { sets.push('NOME = :n'); binds.n = String(b.nome).trim(); }
    if (b.numeroId === null) {
      sets.push('NUMERO_ID = NULL');
    } else if (b.numeroId) {
      sets.push('NUMERO_ID = :num'); binds.num = Number(b.numeroId);
    }
    if (b.definicao) { sets.push('DEFINICAO = :def'); binds.def = JSON.stringify(b.definicao); }

    const upd = await conn.execute(
      `UPDATE MC_ZAP_FLUXO SET ${sets.join(', ')} WHERE ID = :id`,
      binds
    );
    if (!upd.rowsAffected) return res.status(404).json({ error: 'Fluxo não encontrado' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/fluxos/:id/ativar — ativa este e DESATIVA os demais do mesmo número.
router.post('/:id/ativar', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const sel = await conn.execute(
      `SELECT NUMERO_ID, DEFINICAO FROM MC_ZAP_FLUXO WHERE ID = :id`, { id }
    );
    if (!sel.rows.length) return res.status(404).json({ error: 'Fluxo não encontrado' });
    if (!sel.rows[0].NUMERO_ID) {
      return res.status(400).json({ error: 'Vincule o fluxo a um número antes de ativar' });
    }
    const def = JSON.parse(await lerClob(sel.rows[0].DEFINICAO));
    const erros = engine.validarFluxo(def);
    if (erros.length) return res.status(400).json({ error: 'Fluxo inválido — corrija antes de ativar', detalhes: erros });

    await conn.execute(
      `UPDATE MC_ZAP_FLUXO SET ATIVO = 'N' WHERE NUMERO_ID = :num AND ID <> :id`,
      { num: sel.rows[0].NUMERO_ID, id }
    );
    await conn.execute(`UPDATE MC_ZAP_FLUXO SET ATIVO = 'S' WHERE ID = :id`, { id });
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID)
       VALUES (:m, 'fluxo_ativado', 'fluxo', :id)`,
      { m: req.user && req.user.matricula, id }
    );
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/fluxos/:id/desativar
router.post('/:id/desativar', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const upd = await conn.execute(`UPDATE MC_ZAP_FLUXO SET ATIVO = 'N' WHERE ID = :id`, { id });
    if (!upd.rowsAffected) return res.status(404).json({ error: 'Fluxo não encontrado' });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// DELETE /api/fluxos/:id — exclui um fluxo (ADMIN). Proteções:
//   1. fluxo ATIVO não pode ser excluído (desative antes);
//   2. fluxo com conversa EM ANDAMENTO no bot não pode (quebraria o atendimento);
//   3. fluxo referenciado por "irfluxo" de outro fluxo não pode (quebraria o salto);
//   4. referências históricas (conversas já resolvidas) são limpas — o histórico
//      de mensagens permanece, só o ponteiro BOT_FLUXO_ID é solto (FK).
router.delete('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const sel = await conn.execute(
      `SELECT NOME, ATIVO FROM MC_ZAP_FLUXO WHERE ID = :id`, { id }
    );
    if (!sel.rows.length) return res.status(404).json({ error: 'Fluxo não encontrado' });
    const { NOME: nome, ATIVO: ativo } = sel.rows[0];
    if (ativo === 'S') {
      return res.status(409).json({ error: 'Esse fluxo está ATIVO. Desative-o antes de excluir.' });
    }

    const emUso = await conn.execute(
      `SELECT COUNT(*) AS QTD FROM MC_ZAP_CONVERSA
        WHERE BOT_FLUXO_ID = :id AND FILA_STATUS = 'bot'`, { id }
    );
    if (Number(emUso.rows[0].QTD) > 0) {
      return res.status(409).json({
        error: `Há ${emUso.rows[0].QTD} conversa(s) em autoatendimento nesse fluxo agora. Aguarde terminarem (ou o timeout) para excluir.`,
      });
    }

    // Algum outro fluxo salta para este (irfluxo por nome ou id)?
    // Referência por NOME só bloqueia se este for o ÚNICO fluxo com esse nome —
    // havendo um homônimo (ex.: versão nova importada), o salto continua resolvendo.
    const homonimos = await conn.execute(
      `SELECT COUNT(*) AS QTD FROM MC_ZAP_FLUXO
        WHERE UPPER(NOME) = UPPER(:nome) AND ID <> :id`, { nome, id }
    );
    const temHomonimo = Number(homonimos.rows[0].QTD) > 0;
    const outros = await conn.execute(
      `SELECT ID, NOME, DEFINICAO FROM MC_ZAP_FLUXO WHERE ID <> :id`, { id }
    );
    for (const o of outros.rows) {
      try {
        const def = JSON.parse(await lerClob(o.DEFINICAO));
        const referencia = (def.nos || []).some((n) => n.tipo === 'irfluxo'
          && ((!temHomonimo && n.fluxo && String(n.fluxo).toUpperCase() === String(nome).toUpperCase())
            || Number(n.fluxoId) === id));
        if (referencia) {
          return res.status(409).json({
            error: `O fluxo "${o.NOME}" usa "Ir para fluxo" apontando para este. Ajuste-o antes de excluir.`,
          });
        }
      } catch { /* definição ilegível não bloqueia */ }
    }

    // Solta o ponteiro histórico das conversas antigas (FK) e exclui.
    await conn.execute(`UPDATE MC_ZAP_CONVERSA SET BOT_FLUXO_ID = NULL WHERE BOT_FLUXO_ID = :id`, { id });
    await conn.execute(`DELETE FROM MC_ZAP_FLUXO WHERE ID = :id`, { id });
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:m, 'fluxo_excluido', 'fluxo', :id, :det)`,
      { m: req.user && req.user.matricula, id, det: JSON.stringify({ nome }) }
    );
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/fluxos/simular — { definicao, estado?, texto? } → roda o engine.
// estado null/ausente = início do fluxo (saudação). Stateless: o editor guarda
// o estado. Nós 'consulta' executam o SELECT NO BANCO REAL (admin testando) —
// o resultado aparece como evento em `consultas` para o preview exibir.
router.post('/simular', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  const b = req.body || {};
  const erros = engine.validarFluxo(b.definicao);
  if (erros.length) return res.status(400).json({ error: 'Fluxo inválido', detalhes: erros });

  const contexto = { nome: 'Cliente Teste', protocolo: '260101000000' };
  let r = b.estado
    ? engine.avancar(b.definicao, b.estado, String(b.texto || ''), contexto)
    : engine.iniciar(b.definicao, contexto);

  // Resolve consultas em cadeia com o banco real (máx. 5).
  const consultas = [];
  let conn;
  try {
    let mensagens = [...r.mensagens];
    let voltas = 0;
    while (r.acao && r.acao.tipo === 'consulta' && voltas++ < 5) {
      if (!conn) conn = await db.getConnection();
      const { executarConsulta } = require('../bot/runtime');
      const { encontrado, vars, erro } = await executarConsulta(conn, r.acao.no, r.estado.variaveis || {});
      consultas.push({ no: r.acao.no.id, encontrado, vars, erro });
      r = engine.continuarAposConsulta(b.definicao, r.estado, encontrado, vars, contexto);
      mensagens = mensagens.concat(r.mensagens);
    }
    r = { ...r, mensagens };
    // Salto p/ outro fluxo: o simulador é stateless por definição (o editor
    // envia a definição atual) — sinaliza o destino e encerra o teste aqui.
    if (r.acao && r.acao.tipo === 'irFluxo') {
      return res.json({ ...r, acao: null, consultas, irFluxo: r.acao.fluxo || r.acao.fluxoId });
    }
    res.json({ ...r, consultas });
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
