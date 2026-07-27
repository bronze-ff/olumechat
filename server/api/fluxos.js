// api/fluxos.js — CRUD dos fluxos do chatbot (Fase 5C).
// Leitura: ADMIN/SUPERVISOR. Escrita/ativação: ADMIN.
// POST /simular roda o engine puro (alimenta o preview do editor, sem WhatsApp).
//
// req.tenantId: assumido setado por middleware de auth (fora do escopo deste
// ticket — a borda HTTP resolve o tenant a partir do login/JWT, o mesmo padrão
// que o webhook usa a partir do phone_number_id). Toda query passa por
// comTenant(req.tenantId, ...); um fluxo pertence a um tenant.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel } = require('../auth/rbac');
const engine = require('../bot/engine');

const router = express.Router();

// GET /api/fluxos — lista (sem a definição, que pode ser grande).
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  try {
    const linhas = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT f.id, f.nome, f.numero_id, f.ativo, f.versao, f.criado_em, f.atualizado_em,
                n.display_phone, n.nome_exibicao
           FROM fluxo f
           LEFT JOIN numero n ON n.id = f.numero_id
          WHERE f.tenant_id = :tid
          ORDER BY f.ativo DESC, f.nome`,
        { tid: req.tenantId }
      );
      return r.rows;
    });
    res.json(mapRows(linhas));
  } catch (err) {
    next(err);
  }
});

// GET /api/fluxos/:id — com a definição completa.
router.get('/:id', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const row = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT id, nome, numero_id, ativo, versao, definicao FROM fluxo WHERE id = :id AND tenant_id = :tid`,
        { id, tid: req.tenantId }
      );
      return r.rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'Fluxo não encontrado' });
    res.json({
      id: row.ID, nome: row.NOME, numeroId: row.NUMERO_ID, ativo: row.ATIVO,
      versao: row.VERSAO, definicao: row.DEFINICAO, // jsonb já vem parseado
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/fluxos — cria { nome, numeroId?, definicao } (rascunho, ATIVO='N').
router.post('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const erros = engine.validarFluxo(b.definicao);
  if (erros.length) return res.status(400).json({ error: 'Fluxo inválido', detalhes: erros });

  try {
    const { tipos } = db;
    const id = await db.comTenant(req.tenantId, async (conn) => {
      const ins = await conn.execute(
        `INSERT INTO fluxo (nome, numero_id, definicao)
         VALUES (:n, :num, :def) RETURNING id INTO :id`,
        {
          n: nome, num: b.numeroId ? Number(b.numeroId) : null,
          def: JSON.stringify(b.definicao),
          id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
        }
      );
      return ins.outBinds.id[0];
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
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

  try {
    const atualizou = await db.comTenant(req.tenantId, async (conn) => {
      const sets = ['versao = versao + 1', 'atualizado_em = now()'];
      const binds = { id, tid: req.tenantId };
      if (b.nome) { sets.push('nome = :n'); binds.n = String(b.nome).trim(); }
      if (b.numeroId === null) {
        sets.push('numero_id = NULL');
      } else if (b.numeroId) {
        sets.push('numero_id = :num'); binds.num = Number(b.numeroId);
      }
      if (b.definicao) { sets.push('definicao = :def'); binds.def = JSON.stringify(b.definicao); }

      const upd = await conn.execute(
        `UPDATE fluxo SET ${sets.join(', ')} WHERE id = :id AND tenant_id = :tid`,
        binds
      );
      return upd.rowsAffected > 0;
    });
    if (!atualizou) return res.status(404).json({ error: 'Fluxo não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/fluxos/:id/ativar — ativa este e DESATIVA os demais do mesmo número.
router.post('/:id/ativar', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      const tid = req.tenantId;
      const sel = await conn.execute(
        `SELECT numero_id, definicao FROM fluxo WHERE id = :id AND tenant_id = :tid`, { id, tid }
      );
      if (!sel.rows.length) return { status: 404, error: 'Fluxo não encontrado' };
      if (!sel.rows[0].NUMERO_ID) {
        return { status: 400, error: 'Vincule o fluxo a um número antes de ativar' };
      }
      const def = sel.rows[0].DEFINICAO; // jsonb já vem parseado
      const erros = engine.validarFluxo(def);
      if (erros.length) return { status: 400, error: 'Fluxo inválido — corrija antes de ativar', detalhes: erros };

      await conn.execute(
        `UPDATE fluxo SET ativo = 'N' WHERE numero_id = :num AND id <> :id AND tenant_id = :tid`,
        { num: sel.rows[0].NUMERO_ID, id, tid }
      );
      await conn.execute(`UPDATE fluxo SET ativo = 'S' WHERE id = :id AND tenant_id = :tid`, { id, tid });
      await conn.execute(
        `INSERT INTO auditoria (matricula, acao, entidade, entidade_id)
         VALUES (:m, 'fluxo_ativado', 'fluxo', :id)`,
        { m: req.user && req.user.matricula, id }
      );
      return { ok: true };
    });
    if (resultado.error) return res.status(resultado.status).json({ error: resultado.error, detalhes: resultado.detalhes });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/fluxos/:id/desativar
router.post('/:id/desativar', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const atualizou = await db.comTenant(req.tenantId, async (conn) => {
      const upd = await conn.execute(
        `UPDATE fluxo SET ativo = 'N' WHERE id = :id AND tenant_id = :tid`, { id, tid: req.tenantId }
      );
      return upd.rowsAffected > 0;
    });
    if (!atualizou) return res.status(404).json({ error: 'Fluxo não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
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
  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      const tid = req.tenantId;
      const sel = await conn.execute(`SELECT nome, ativo FROM fluxo WHERE id = :id AND tenant_id = :tid`, { id, tid });
      if (!sel.rows.length) return { status: 404, error: 'Fluxo não encontrado' };
      const { NOME: nome, ATIVO: ativo } = sel.rows[0];
      if (ativo === 'S') {
        return { status: 409, error: 'Esse fluxo está ATIVO. Desative-o antes de excluir.' };
      }

      const emUso = await conn.execute(
        `SELECT COUNT(*) AS qtd FROM conversa
          WHERE bot_fluxo_id = :id AND fila_status = 'bot' AND tenant_id = :tid`, { id, tid }
      );
      if (Number(emUso.rows[0].QTD) > 0) {
        return {
          status: 409,
          error: `Há ${emUso.rows[0].QTD} conversa(s) em autoatendimento nesse fluxo agora. Aguarde terminarem (ou o timeout) para excluir.`,
        };
      }

      // Algum outro fluxo salta para este (irfluxo por nome ou id)?
      // Referência por NOME só bloqueia se este for o ÚNICO fluxo com esse nome —
      // havendo um homônimo (ex.: versão nova importada), o salto continua resolvendo.
      const homonimos = await conn.execute(
        `SELECT COUNT(*) AS qtd FROM fluxo WHERE upper(nome) = upper(:nome) AND id <> :id AND tenant_id = :tid`,
        { nome, id, tid }
      );
      const temHomonimo = Number(homonimos.rows[0].QTD) > 0;
      const outros = await conn.execute(
        `SELECT id, nome, definicao FROM fluxo WHERE id <> :id AND tenant_id = :tid`, { id, tid }
      );
      for (const o of outros.rows) {
        const def = o.DEFINICAO; // jsonb já vem parseado
        const referencia = (def.nos || []).some((n) => n.tipo === 'irfluxo'
          && ((!temHomonimo && n.fluxo && String(n.fluxo).toUpperCase() === String(nome).toUpperCase())
            || Number(n.fluxoId) === id));
        if (referencia) {
          return { status: 409, error: `O fluxo "${o.NOME}" usa "Ir para fluxo" apontando para este. Ajuste-o antes de excluir.` };
        }
      }

      // Solta o ponteiro histórico das conversas antigas (FK) e exclui.
      await conn.execute(`UPDATE conversa SET bot_fluxo_id = NULL WHERE bot_fluxo_id = :id AND tenant_id = :tid`, { id, tid });
      await conn.execute(`DELETE FROM fluxo WHERE id = :id AND tenant_id = :tid`, { id, tid });
      await conn.execute(
        `INSERT INTO auditoria (matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:m, 'fluxo_excluido', 'fluxo', :id, :det)`,
        { m: req.user && req.user.matricula, id, det: JSON.stringify({ nome }) }
      );
      return { ok: true };
    });
    if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/fluxos/simular — { definicao, estado?, texto? } → roda o engine.
// estado null/ausente = início do fluxo (saudação). Stateless: o editor guarda
// o estado. Nós 'consulta' executam o SELECT NO BANCO REAL (admin testando),
// escopado ao tenant do admin via comTenant() — o resultado aparece como
// evento em `consultas` para o preview exibir.
router.post('/simular', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  const b = req.body || {};
  const erros = engine.validarFluxo(b.definicao);
  if (erros.length) return res.status(400).json({ error: 'Fluxo inválido', detalhes: erros });

  const contexto = { nome: 'Cliente Teste', protocolo: '260101000000' };
  let r = b.estado
    ? engine.avancar(b.definicao, b.estado, String(b.texto || ''), contexto)
    : engine.iniciar(b.definicao, contexto);

  try {
    const consultas = [];
    const resolverConsultas = async (conn) => {
      let mensagens = [...r.mensagens];
      let voltas = 0;
      while (r.acao && r.acao.tipo === 'consulta' && voltas++ < 5) {
        const { executarConsulta } = require('../bot/runtime');
        const { encontrado, vars, erro } = await executarConsulta(conn, r.acao.no, r.estado.variaveis || {});
        consultas.push({ no: r.acao.no.id, encontrado, vars, erro });
        r = engine.continuarAposConsulta(b.definicao, r.estado, encontrado, vars, contexto);
        mensagens = mensagens.concat(r.mensagens);
      }
      r = { ...r, mensagens };
    };
    if (r.acao && r.acao.tipo === 'consulta') {
      await db.comTenant(req.tenantId, resolverConsultas);
    }
    // Salto p/ outro fluxo: o simulador é stateless por definição (o editor
    // envia a definição atual) — sinaliza o destino e encerra o teste aqui.
    if (r.acao && r.acao.tipo === 'irFluxo') {
      return res.json({ ...r, acao: null, consultas, irFluxo: r.acao.fluxo || r.acao.fluxoId });
    }
    res.json({ ...r, consultas });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
