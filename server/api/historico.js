// api/historico.js — Histórico pesquisável de atendimentos + export CSV (Fase 5D).
// ADMIN/AUDITOR veem tudo; SUPERVISOR escopado aos seus departamentos.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel } = require('../auth/rbac');

const router = express.Router();

const POR_PAGINA = 25;
const TAMANHOS_PAGINA = [25, 50, 100, 500]; // opções de itens por página
const MAX_EXPORT = 10000;

// Colunas permitidas p/ ordenação (whitelist). ORDER BY não aceita bind,
// então a coluna entra como literal — NUNCA a string crua do query param (anti-injeção).
const COLUNAS_ORD = {
  protocolo: 'c.protocolo', cliente: 'ct.nome_perfil', departamento: 'd.nome',
  atendente: 'a.nome', status: 'c.fila_status', criado: 'c.criado_em', finalizado: 'c.resolvida_em',
};
function ordenacao(req) {
  const col = COLUNAS_ORD[String(req.query.orderBy || '').toLowerCase()] || 'c.criado_em';
  const dir = String(req.query.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `${col} ${dir} NULLS LAST, c.id DESC`;
}

/** Monta WHERE comum: tenant_id é a PRIMEIRA condição (índices — ver migração 001/002). */
function montarFiltro(req, opts = {}) {
  const conds = [`c.tenant_id = :tenantId`];
  const binds = { tenantId: req.tenantId };
  const protocolo = String(req.query.protocolo || '').replace(/\D/g, '');
  const q = String(req.query.q || '').trim();
  if (protocolo) { conds.push(`c.protocolo = :prot`); binds.prot = protocolo; }
  if (q) {
    conds.push(`(UPPER(ct.nome_perfil) LIKE UPPER('%'||:q||'%') OR ct.telefone LIKE '%'||:qd||'%')`);
    binds.q = q;
    binds.qd = q.replace(/\D/g, '') || ' ';
  }
  const atd = Number(req.query.atendenteId) || null;
  if (atd) { conds.push(`c.atendente_id = :atd`); binds.atd = atd; }
  const dep = Number(req.query.departamentoId) || null;
  if (dep) { conds.push(`c.departamento_id = :dep`); binds.dep = dep; }
  const fila = String(req.query.filaStatus || '').trim();
  if (!opts.semStatus && ['bot', 'aguardando', 'em_atendimento', 'resolvida'].includes(fila)) {
    conds.push(`c.fila_status = :fila`); binds.fila = fila;
  }
  const origem = String(req.query.origem || '').trim();
  if (['ativa', 'receptiva'].includes(origem)) { conds.push(`c.origem = :origem`); binds.origem = origem; }
  const de = String(req.query.de || '').trim();
  const ate = String(req.query.ate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(de)) { conds.push(`c.criado_em >= :de::date`); binds.de = de; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(ate)) { conds.push(`c.criado_em < :ate::date + 1`); binds.ate = ate; }

  if (req.perfil.papel === 'SUPERVISOR') {
    if (req.perfil.deptoIds.length) {
      const ms = req.perfil.deptoIds.map((d, i) => { binds[`sd${i}`] = d; return `:sd${i}`; });
      conds.push(`c.departamento_id IN (${ms.join(',')})`);
    } else {
      conds.push(`1 = 0`);
    }
  }
  return { where: `WHERE ${conds.join(' AND ')}`, binds };
}

const SELECT_BASE = `
  SELECT c.id, c.protocolo, c.fila_status, c.origem, c.criado_em, c.fila_entrou_em,
         c.atribuida_em, c.resolvida_em,
         ct.nome_perfil, ct.telefone, ct.codcli,
         d.nome AS DEPARTAMENTO, a.nome AS ATENDENTE,
         n.nome_exibicao AS NUMERO_NOME, n.display_phone AS NUMERO_FONE,
         (SELECT mm.conteudo
            FROM mensagem mm
           WHERE mm.tenant_id = c.tenant_id AND mm.conversa_id = c.id
           ORDER BY mm.ts DESC NULLS LAST, mm.id DESC
           LIMIT 1) AS ULTIMA_MSG
    FROM conversa c
    JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
    LEFT JOIN departamento d ON d.tenant_id = c.tenant_id AND d.id = c.departamento_id
    LEFT JOIN atendente a ON a.tenant_id = c.tenant_id AND a.id = c.atendente_id
    LEFT JOIN numero n ON n.tenant_id = c.tenant_id AND n.id = c.numero_id`;

// GET /api/historico?pagina=1&… — lista paginada + total.
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const porPagina = TAMANHOS_PAGINA.includes(Number(req.query.porPagina)) ? Number(req.query.porPagina) : POR_PAGINA;
  const { where, binds } = montarFiltro(req);
  try {
    const { total, itens } = await db.comTenant(req.tenantId, async (conn) => {
      const totalR = await conn.execute(
        `SELECT COUNT(*) AS QTD FROM conversa c
           JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id ${where}`,
        binds
      );
      const rows = await conn.execute(
        `${SELECT_BASE} ${where}
          ORDER BY ${ordenacao(req)}
          OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
        { ...binds, off: (pagina - 1) * porPagina, lim: porPagina }
      );
      return { total: totalR.rows[0].QTD, itens: rows.rows };
    });
    res.json({
      total,
      pagina,
      porPagina,
      itens: mapRows(itens).map((r) => ({ ...r, nomePerfil: r.nomePerfil, ultimaMsg: r.ultimaMsg })),
    });
  } catch (err) {
    next(err);
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
  try {
    const linhasCsv = await db.comTenant(req.tenantId, async (conn) => {
      const rows = await conn.execute(
        `${SELECT_BASE} ${where}
          ORDER BY c.criado_em DESC
          FETCH FIRST ${MAX_EXPORT} ROWS ONLY`,
        binds
      );
      // tenant_id nasce do DEFAULT tenant_atual() dentro de comTenant() — não
      // precisa ser citado no INSERT (ver cabeçalho de db/pool.js).
      await conn.execute(
        `INSERT INTO auditoria (matricula, acao, entidade, detalhe)
         VALUES (:m, 'export_csv', 'historico', :det)`,
        { m: req.user && req.user.matricula, det: JSON.stringify({ filtros: req.query, linhas: rows.rows.length }) }
      );
      return rows.rows;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="atendimentos.csv"');
    const cab = ['Protocolo', 'Status', 'Origem', 'Cliente', 'Telefone', 'CodCli', 'Departamento', 'Atendente', 'Criado em', 'Atribuido em', 'Resolvido em', 'Ultima mensagem'];
    const linhas = [cab.join(';')];
    for (const r of linhasCsv) {
      linhas.push([
        r.PROTOCOLO, r.FILA_STATUS, r.ORIGEM, r.NOME_PERFIL, r.TELEFONE, r.CODCLI,
        r.DEPARTAMENTO, r.ATENDENTE,
        r.CRIADO_EM ? new Date(r.CRIADO_EM).toLocaleString('pt-BR') : '',
        r.ATRIBUIDA_EM ? new Date(r.ATRIBUIDA_EM).toLocaleString('pt-BR') : '',
        r.RESOLVIDA_EM ? new Date(r.RESOLVIDA_EM).toLocaleString('pt-BR') : '',
        r.ULTIMA_MSG,
      ].map(csvEscape).join(';'));
    }
    res.send('﻿' + linhas.join('\r\n')); // BOM p/ Excel abrir com acentos
  } catch (err) {
    next(err);
  }
});

// GET /api/historico/contagens — contagem por FILA_STATUS (respeita os demais
// filtros, ignora o de status) → alimenta os chips rápidos do Histórico.
router.get('/contagens', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const { where, binds } = montarFiltro(req, { semStatus: true });
  try {
    const linhas = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT c.fila_status, COUNT(*) AS QTD
           FROM conversa c
           JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id ${where}
          GROUP BY c.fila_status`,
        binds
      );
      return r.rows;
    });
    const out = { em_atendimento: 0, aguardando: 0, bot: 0, resolvida: 0, total: 0 };
    for (const row of linhas) {
      if (Object.prototype.hasOwnProperty.call(out, row.FILA_STATUS)) out[row.FILA_STATUS] = row.QTD;
      out.total += row.QTD;
    }
    res.json(out);
  } catch (err) {
    next(err);
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
  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      const cv = await conn.execute(
        `SELECT c.criado_em, c.fila_entrou_em, c.origem, c.departamento_id, d.nome AS DEPARTAMENTO
           FROM conversa c
           LEFT JOIN departamento d ON d.tenant_id = c.tenant_id AND d.id = c.departamento_id
          WHERE c.tenant_id = :tenantId AND c.id = :id`,
        { tenantId: req.tenantId, id }
      );
      if (!cv.rows.length) return { encontrado: false };
      const conv = cv.rows[0];
      if (req.perfil.papel === 'SUPERVISOR' && !(req.perfil.deptoIds || []).includes(conv.DEPARTAMENTO_ID)) {
        return { encontrado: false };
      }
      const aud = await conn.execute(
        `SELECT au.acao, au.criado_em, a.nome AS ATENDENTE
           FROM auditoria au
           LEFT JOIN atendente a ON a.tenant_id = au.tenant_id AND a.id = au.atendente_id
          WHERE au.tenant_id = :tenantId AND au.entidade = 'conversa' AND au.entidade_id = :id
          ORDER BY au.criado_em`,
        { tenantId: req.tenantId, id }
      );
      return { encontrado: true, conv, aud: aud.rows };
    });

    if (!resultado.encontrado) return res.status(404).json({ error: 'Atendimento não encontrado' });
    const { conv, aud } = resultado;
    const eventos = [];
    if (conv.CRIADO_EM) eventos.push({ ts: conv.CRIADO_EM, tipo: 'criado', texto: `Atendimento criado (${conv.ORIGEM || 'receptiva'})` });
    if (conv.FILA_ENTROU_EM) eventos.push({ ts: conv.FILA_ENTROU_EM, tipo: 'fila', texto: `Entrou na fila${conv.DEPARTAMENTO ? ' — ' + conv.DEPARTAMENTO : ''}` });
    for (const r of mapRows(aud)) {
      const base = ROTULO_ACAO[r.acao] || r.acao;
      eventos.push({ ts: r.criadoEm, tipo: r.acao, texto: r.atendente ? `${base} — ${r.atendente}` : base });
    }
    eventos.sort((x, y) => new Date(x.ts) - new Date(y.ts));
    res.json({ eventos });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
