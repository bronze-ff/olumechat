// api/historico.js — Histórico pesquisável de atendimentos + export CSV (Fase 5D).
// ADMIN/AUDITOR veem tudo; SUPERVISOR escopado aos seus departamentos.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/oracleHelper');
const { exigirPapel } = require('../auth/rbac');
const { decodificar } = require('../utils/texto');

const router = express.Router();

const POR_PAGINA = 25;
const TAMANHOS_PAGINA = [25, 50, 100, 500]; // opções de itens por página
const MAX_EXPORT = 10000;

// Colunas permitidas p/ ordenação (whitelist). ORDER BY não aceita bind no Oracle,
// então a coluna entra como literal — NUNCA a string crua do query param (anti-injeção).
const COLUNAS_ORD = {
  protocolo: 'c.PROTOCOLO', cliente: 'ct.NOME_PERFIL', departamento: 'd.NOME',
  atendente: 'a.NOME', status: 'c.FILA_STATUS', criado: 'c.CRIADO_EM', finalizado: 'c.RESOLVIDA_EM',
};
function ordenacao(req) {
  const col = COLUNAS_ORD[String(req.query.orderBy || '').toLowerCase()] || 'c.CRIADO_EM';
  const dir = String(req.query.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `${col} ${dir} NULLS LAST, c.ID DESC`;
}

function montarFiltro(req, opts = {}) {
  const conds = [];
  const binds = {};
  const protocolo = String(req.query.protocolo || '').replace(/\D/g, '');
  const q = String(req.query.q || '').trim();
  if (protocolo) { conds.push(`c.PROTOCOLO = :prot`); binds.prot = protocolo; }
  if (q) {
    conds.push(`(UPPER(ct.NOME_PERFIL) LIKE UPPER('%'||:q||'%') OR ct.TELEFONE LIKE '%'||:qd||'%')`);
    binds.q = q;
    binds.qd = q.replace(/\D/g, '') || ' ';
  }
  const atd = Number(req.query.atendenteId) || null;
  if (atd) { conds.push(`c.ATENDENTE_ID = :atd`); binds.atd = atd; }
  const dep = Number(req.query.departamentoId) || null;
  if (dep) { conds.push(`c.DEPARTAMENTO_ID = :dep`); binds.dep = dep; }
  const fila = String(req.query.filaStatus || '').trim();
  if (!opts.semStatus && ['bot', 'aguardando', 'em_atendimento', 'resolvida'].includes(fila)) {
    conds.push(`c.FILA_STATUS = :fila`); binds.fila = fila;
  }
  const origem = String(req.query.origem || '').trim();
  if (['ativa', 'receptiva'].includes(origem)) { conds.push(`c.ORIGEM = :origem`); binds.origem = origem; }
  const de = String(req.query.de || '').trim();
  const ate = String(req.query.ate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(de)) { conds.push(`c.CRIADO_EM >= TO_DATE(:de,'YYYY-MM-DD')`); binds.de = de; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(ate)) { conds.push(`c.CRIADO_EM < TO_DATE(:ate,'YYYY-MM-DD') + 1`); binds.ate = ate; }

  if (req.perfil.papel === 'SUPERVISOR') {
    if (req.perfil.deptoIds.length) {
      const ms = req.perfil.deptoIds.map((d, i) => { binds[`sd${i}`] = d; return `:sd${i}`; });
      conds.push(`c.DEPARTAMENTO_ID IN (${ms.join(',')})`);
    } else {
      conds.push(`1 = 0`);
    }
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', binds };
}

const SELECT_BASE = `
  SELECT c.ID, c.PROTOCOLO, c.FILA_STATUS, c.ORIGEM, c.CRIADO_EM, c.FILA_ENTROU_EM,
         c.ATRIBUIDA_EM, c.RESOLVIDA_EM,
         ct.NOME_PERFIL, ct.TELEFONE, ct.CODCLI,
         d.NOME AS DEPARTAMENTO, a.NOME AS ATENDENTE,
         n.NOME_EXIBICAO AS NUMERO_NOME, n.DISPLAY_PHONE AS NUMERO_FONE,
         (SELECT m.CONTEUDO FROM (
            SELECT CONTEUDO FROM MC_ZAP_MENSAGEM mm
             WHERE mm.CONVERSA_ID = c.ID
             ORDER BY mm.TS DESC NULLS LAST, mm.ID DESC
          ) m WHERE ROWNUM = 1) AS ULTIMA_MSG
    FROM MC_ZAP_CONVERSA c
    JOIN MC_ZAP_CONTATO ct ON ct.ID = c.CONTATO_ID
    LEFT JOIN MC_ZAP_DEPARTAMENTO d ON d.ID = c.DEPARTAMENTO_ID
    LEFT JOIN MC_ZAP_ATENDENTE a ON a.ID = c.ATENDENTE_ID
    LEFT JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID`;

// GET /api/historico?pagina=1&… — lista paginada + total.
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const porPagina = TAMANHOS_PAGINA.includes(Number(req.query.porPagina)) ? Number(req.query.porPagina) : POR_PAGINA;
  const { where, binds } = montarFiltro(req);
  let conn;
  try {
    conn = await db.getConnection();
    const total = await conn.execute(
      `SELECT COUNT(*) AS QTD FROM MC_ZAP_CONVERSA c
         JOIN MC_ZAP_CONTATO ct ON ct.ID = c.CONTATO_ID ${where}`,
      binds
    );
    const rows = await conn.execute(
      `${SELECT_BASE} ${where}
        ORDER BY ${ordenacao(req)}
        OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      { ...binds, off: (pagina - 1) * porPagina, lim: porPagina }
    );
    res.json({
      total: total.rows[0].QTD,
      pagina,
      porPagina,
      itens: mapRows(rows.rows).map((r) => ({ ...r, nomePerfil: decodificar(r.nomePerfil), ultimaMsg: decodificar(r.ultimaMsg) })),
    });
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/historico/export.csv — mesmos filtros; download auditado (LGPD).
router.get('/export.csv', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const { where, binds } = montarFiltro(req);
  let conn;
  try {
    conn = await db.getConnection();
    const rows = await conn.execute(
      `${SELECT_BASE} ${where}
        ORDER BY c.CRIADO_EM DESC
        FETCH FIRST ${MAX_EXPORT} ROWS ONLY`,
      binds
    );
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (MATRICULA, ACAO, ENTIDADE, DETALHE)
       VALUES (:m, 'export_csv', 'historico', :det)`,
      { m: req.user && req.user.matricula, det: JSON.stringify({ filtros: req.query, linhas: rows.rows.length }) }
    );
    await conn.commit();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="atendimentos.csv"');
    const cab = ['Protocolo', 'Status', 'Origem', 'Cliente', 'Telefone', 'CodCli', 'Departamento', 'Atendente', 'Criado em', 'Atribuido em', 'Resolvido em', 'Ultima mensagem'];
    const linhas = [cab.join(';')];
    for (const r of rows.rows) {
      linhas.push([
        r.PROTOCOLO, r.FILA_STATUS, r.ORIGEM, decodificar(r.NOME_PERFIL), r.TELEFONE, r.CODCLI,
        r.DEPARTAMENTO, r.ATENDENTE,
        r.CRIADO_EM ? new Date(r.CRIADO_EM).toLocaleString('pt-BR') : '',
        r.ATRIBUIDA_EM ? new Date(r.ATRIBUIDA_EM).toLocaleString('pt-BR') : '',
        r.RESOLVIDA_EM ? new Date(r.RESOLVIDA_EM).toLocaleString('pt-BR') : '',
        decodificar(r.ULTIMA_MSG),
      ].map(csvEscape).join(';'));
    }
    res.send('﻿' + linhas.join('\r\n')); // BOM p/ Excel abrir com acentos
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/historico/contagens — contagem por FILA_STATUS (respeita os demais
// filtros, ignora o de status) → alimenta os chips rápidos do Histórico.
router.get('/contagens', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const { where, binds } = montarFiltro(req, { semStatus: true });
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT c.FILA_STATUS, COUNT(*) AS QTD
         FROM MC_ZAP_CONVERSA c
         JOIN MC_ZAP_CONTATO ct ON ct.ID = c.CONTATO_ID ${where}
        GROUP BY c.FILA_STATUS`,
      binds
    );
    const out = { em_atendimento: 0, aguardando: 0, bot: 0, resolvida: 0, total: 0 };
    for (const row of r.rows) {
      if (Object.prototype.hasOwnProperty.call(out, row.FILA_STATUS)) out[row.FILA_STATUS] = row.QTD;
      out.total += row.QTD;
    }
    res.json(out);
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/historico/:id/atendimento — linha do tempo de UM atendimento:
// eventos do AUDITORIA da conversa (auto-atribuição, assumir, transferência,
// encerramento) + marcos de horário (criado / entrou na fila). Read-only;
// SUPERVISOR só enxerga atendimentos dos seus departamentos.
const ROTULO_ACAO = {
  atribuicao_auto: 'Atribuído automaticamente',
  atribuicao: 'Assumido',
  transferencia: 'Transferido',
  encerramento: 'Atendimento encerrado',
  fila_sem_agentes: 'Todos os atendentes do departamento offline',
  fila_fora_horario: 'Fora do horário de atendimento',
};

router.get('/:id/atendimento', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const cv = await conn.execute(
      `SELECT c.CRIADO_EM, c.FILA_ENTROU_EM, c.ORIGEM, c.DEPARTAMENTO_ID, d.NOME AS DEPARTAMENTO
         FROM MC_ZAP_CONVERSA c
         LEFT JOIN MC_ZAP_DEPARTAMENTO d ON d.ID = c.DEPARTAMENTO_ID
        WHERE c.ID = :id`,
      { id }
    );
    if (!cv.rows.length) return res.status(404).json({ error: 'Atendimento não encontrado' });
    const conv = cv.rows[0];
    if (req.perfil.papel === 'SUPERVISOR' && !(req.perfil.deptoIds || []).includes(conv.DEPARTAMENTO_ID)) {
      return res.status(404).json({ error: 'Atendimento não encontrado' });
    }
    const aud = await conn.execute(
      `SELECT au.ACAO, au.CRIADO_EM, a.NOME AS ATENDENTE
         FROM MC_ZAP_AUDITORIA au
         LEFT JOIN MC_ZAP_ATENDENTE a ON a.ID = au.ATENDENTE_ID
        WHERE au.ENTIDADE = 'conversa' AND au.ENTIDADE_ID = :id
        ORDER BY au.CRIADO_EM`,
      { id }
    );
    const eventos = [];
    if (conv.CRIADO_EM) eventos.push({ ts: conv.CRIADO_EM, tipo: 'criado', texto: `Atendimento criado (${conv.ORIGEM || 'receptiva'})` });
    if (conv.FILA_ENTROU_EM) eventos.push({ ts: conv.FILA_ENTROU_EM, tipo: 'fila', texto: `Entrou na fila${conv.DEPARTAMENTO ? ' — ' + conv.DEPARTAMENTO : ''}` });
    for (const r of mapRows(aud.rows)) {
      const base = ROTULO_ACAO[r.acao] || r.acao;
      eventos.push({ ts: r.criadoEm, tipo: r.acao, texto: r.atendente ? `${base} — ${r.atendente}` : base });
    }
    eventos.sort((x, y) => new Date(x.ts) - new Date(y.ts));
    res.json({ eventos });
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
