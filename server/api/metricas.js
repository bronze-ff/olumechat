// api/metricas.js — Indicadores de atendimento (Fase 5D).
// ADMIN/AUDITOR veem tudo; SUPERVISOR escopado aos seus departamentos.
// Tempos em SEGUNDOS: espera = ATRIBUIDA_EM-FILA_ENTROU_EM ·
// duração = RESOLVIDA_EM-ATRIBUIDA_EM · TMR = PRIMEIRA_RESPOSTA_EM-ATRIBUIDA_EM.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel } = require('../auth/rbac');

const router = express.Router();

// Diferença em segundos entre dois timestamptz (equivalente ao
// `(CAST(a AS DATE) - CAST(b AS DATE)) * 86400` do Oracle — ver PORTE.md).
const SEG = (a, b) => `EXTRACT(EPOCH FROM (${a} - ${b}))`;

/**
 * Monta WHERE comum: tenant + período + departamento + escopo do supervisor.
 * tenant_id é a PRIMEIRA condição — casa com o índice
 * ix_conv_tenant_criado (migração 002) que sustenta estas agregações.
 */
function montarFiltro(req) {
  const conds = [`c.tenant_id = :tenantId`, `c.protocolo IS NOT NULL`]; // só atendimentos de fila/bot contam
  const binds = { tenantId: req.tenantId };
  const de = String(req.query.de || '').trim();
  const ate = String(req.query.ate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(de)) { conds.push(`c.criado_em >= :de::date`); binds.de = de; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(ate)) { conds.push(`c.criado_em < :ate::date + 1`); binds.ate = ate; }
  const dep = Number(req.query.departamentoId) || null;
  if (dep) { conds.push(`c.departamento_id = :dep`); binds.dep = dep; }

  if (req.perfil.papel === 'SUPERVISOR') {
    if (req.perfil.deptoIds.length) {
      const ms = req.perfil.deptoIds.map((d, i) => { binds[`sd${i}`] = d; return `:sd${i}`; });
      conds.push(`c.departamento_id IN (${ms.join(',')})`);
    } else {
      conds.push(`1 = 0`); // supervisor sem depto não vê nada
    }
  }
  return { where: `WHERE ${conds.join(' AND ')}`, binds };
}

// GET /api/metricas/resumo?de=&ate=&departamentoId=
router.get('/resumo', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const { where, binds } = montarFiltro(req);
  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      const totais = await conn.execute(
        `SELECT COUNT(*) AS TOTAL,
                SUM(CASE WHEN c.fila_status = 'resolvida' THEN 1 ELSE 0 END) AS RESOLVIDAS,
                SUM(CASE WHEN c.fila_status = 'aguardando' THEN 1 ELSE 0 END) AS AGUARDANDO,
                SUM(CASE WHEN c.fila_status = 'em_atendimento' THEN 1 ELSE 0 END) AS EM_ATENDIMENTO,
                SUM(CASE WHEN c.fila_status = 'bot' THEN 1 ELSE 0 END) AS NO_BOT,
                SUM(CASE WHEN c.origem = 'ativa' THEN 1 ELSE 0 END) AS ATIVAS,
                SUM(CASE WHEN c.origem = 'receptiva' THEN 1 ELSE 0 END) AS RECEPTIVAS,
                ROUND(AVG(${SEG('c.atribuida_em', 'c.fila_entrou_em')})::numeric) AS ESPERA_MEDIA_SEG,
                ROUND(AVG(${SEG('c.primeira_resposta_em', 'c.atribuida_em')})::numeric) AS TMR_MEDIO_SEG,
                ROUND(AVG(${SEG('c.resolvida_em', 'c.atribuida_em')})::numeric) AS DURACAO_MEDIA_SEG
           FROM conversa c ${where}`,
        binds
      );

      const porDia = await conn.execute(
        `SELECT TO_CHAR(date_trunc('day', c.criado_em), 'YYYY-MM-DD') AS DIA, COUNT(*) AS QTD
           FROM conversa c ${where}
          GROUP BY date_trunc('day', c.criado_em) ORDER BY date_trunc('day', c.criado_em)`,
        binds
      );

      const porDepto = await conn.execute(
        `SELECT d.id, d.nome, d.cor, COUNT(*) AS QTD,
                SUM(CASE WHEN c.fila_status = 'resolvida' THEN 1 ELSE 0 END) AS RESOLVIDAS,
                ROUND(AVG(${SEG('c.atribuida_em', 'c.fila_entrou_em')})::numeric) AS ESPERA_MEDIA_SEG
           FROM conversa c
           JOIN departamento d ON d.tenant_id = c.tenant_id AND d.id = c.departamento_id
          ${where}
          GROUP BY d.id, d.nome, d.cor ORDER BY QTD DESC`,
        binds
      );

      const porAtendente = await conn.execute(
        `SELECT a.id, a.nome, a.matricula, COUNT(*) AS QTD,
                SUM(CASE WHEN c.fila_status = 'resolvida' THEN 1 ELSE 0 END) AS RESOLVIDAS,
                SUM(CASE WHEN c.origem = 'ativa' THEN 1 ELSE 0 END) AS ATIVAS,
                SUM(CASE WHEN c.origem = 'receptiva' THEN 1 ELSE 0 END) AS RECEPTIVAS,
                ROUND(AVG(${SEG('c.primeira_resposta_em', 'c.atribuida_em')})::numeric) AS TMR_MEDIO_SEG,
                ROUND(AVG(${SEG('c.resolvida_em', 'c.atribuida_em')})::numeric) AS DURACAO_MEDIA_SEG
           FROM conversa c
           JOIN atendente a ON a.tenant_id = c.tenant_id AND a.id = c.atendente_id
          ${where}
          GROUP BY a.id, a.nome, a.matricula ORDER BY QTD DESC`,
        binds
      );

      // Quebra por dia + atendente (alimenta o tooltip do gráfico "por dia").
      // LEFT JOIN + COALESCE inclui conversas sem atendente (bot/fila) para a
      // soma do breakdown fechar com o total da barra do dia.
      const porDiaAtendente = await conn.execute(
        `SELECT TO_CHAR(date_trunc('day', c.criado_em), 'YYYY-MM-DD') AS DIA,
                COALESCE(a.nome, 'Sem atendente') AS NOME,
                COUNT(*) AS QTD
           FROM conversa c
           LEFT JOIN atendente a ON a.tenant_id = c.tenant_id AND a.id = c.atendente_id
          ${where}
          GROUP BY date_trunc('day', c.criado_em), COALESCE(a.nome, 'Sem atendente')
          ORDER BY DIA, QTD DESC`,
        binds
      );

      return { totais, porDia, porDiaAtendente, porDepto, porAtendente };
    });

    res.json({
      totais: mapRows(resultado.totais.rows)[0] || {},
      porDia: mapRows(resultado.porDia.rows),
      porDiaAtendente: mapRows(resultado.porDiaAtendente.rows),
      porDepto: mapRows(resultado.porDepto.rows),
      porAtendente: mapRows(resultado.porAtendente.rows),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
