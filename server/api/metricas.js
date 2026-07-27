// api/metricas.js — Indicadores de atendimento (Fase 5D).
// ADMIN/AUDITOR veem tudo; SUPERVISOR escopado aos seus departamentos.
// Tempos em SEGUNDOS: espera = ATRIBUIDA_EM-FILA_ENTROU_EM ·
// duração = RESOLVIDA_EM-ATRIBUIDA_EM · TMR = PRIMEIRA_RESPOSTA_EM-ATRIBUIDA_EM.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/oracleHelper');
const { exigirPapel } = require('../auth/rbac');

const router = express.Router();

const SEG = (a, b) => `(CAST(${a} AS DATE) - CAST(${b} AS DATE)) * 86400`;

/** Monta WHERE comum: período + departamento + escopo do supervisor. */
function montarFiltro(req) {
  const conds = [`c.PROTOCOLO IS NOT NULL`]; // só atendimentos de fila/bot contam
  const binds = {};
  const de = String(req.query.de || '').trim();
  const ate = String(req.query.ate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(de)) { conds.push(`c.CRIADO_EM >= TO_DATE(:de,'YYYY-MM-DD')`); binds.de = de; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(ate)) { conds.push(`c.CRIADO_EM < TO_DATE(:ate,'YYYY-MM-DD') + 1`); binds.ate = ate; }
  const dep = Number(req.query.departamentoId) || null;
  if (dep) { conds.push(`c.DEPARTAMENTO_ID = :dep`); binds.dep = dep; }

  if (req.perfil.papel === 'SUPERVISOR') {
    if (req.perfil.deptoIds.length) {
      const ms = req.perfil.deptoIds.map((d, i) => { binds[`sd${i}`] = d; return `:sd${i}`; });
      conds.push(`c.DEPARTAMENTO_ID IN (${ms.join(',')})`);
    } else {
      conds.push(`1 = 0`); // supervisor sem depto não vê nada
    }
  }
  return { where: `WHERE ${conds.join(' AND ')}`, binds };
}

// GET /api/metricas/resumo?de=&ate=&departamentoId=
router.get('/resumo', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  const { where, binds } = montarFiltro(req);
  let conn;
  try {
    conn = await db.getConnection();

    const totais = await conn.execute(
      `SELECT COUNT(*) AS TOTAL,
              SUM(CASE WHEN c.FILA_STATUS = 'resolvida' THEN 1 ELSE 0 END) AS RESOLVIDAS,
              SUM(CASE WHEN c.FILA_STATUS = 'aguardando' THEN 1 ELSE 0 END) AS AGUARDANDO,
              SUM(CASE WHEN c.FILA_STATUS = 'em_atendimento' THEN 1 ELSE 0 END) AS EM_ATENDIMENTO,
              SUM(CASE WHEN c.FILA_STATUS = 'bot' THEN 1 ELSE 0 END) AS NO_BOT,
              SUM(CASE WHEN c.ORIGEM = 'ativa' THEN 1 ELSE 0 END) AS ATIVAS,
              SUM(CASE WHEN c.ORIGEM = 'receptiva' THEN 1 ELSE 0 END) AS RECEPTIVAS,
              ROUND(AVG(${SEG('c.ATRIBUIDA_EM', 'c.FILA_ENTROU_EM')})) AS ESPERA_MEDIA_SEG,
              ROUND(AVG(${SEG('c.PRIMEIRA_RESPOSTA_EM', 'c.ATRIBUIDA_EM')})) AS TMR_MEDIO_SEG,
              ROUND(AVG(${SEG('c.RESOLVIDA_EM', 'c.ATRIBUIDA_EM')})) AS DURACAO_MEDIA_SEG
         FROM MC_ZAP_CONVERSA c ${where}`,
      binds
    );

    const porDia = await conn.execute(
      `SELECT TO_CHAR(TRUNC(c.CRIADO_EM), 'YYYY-MM-DD') AS DIA, COUNT(*) AS QTD
         FROM MC_ZAP_CONVERSA c ${where}
        GROUP BY TRUNC(c.CRIADO_EM) ORDER BY TRUNC(c.CRIADO_EM)`,
      binds
    );

    const porDepto = await conn.execute(
      `SELECT d.ID, d.NOME, d.COR, COUNT(*) AS QTD,
              SUM(CASE WHEN c.FILA_STATUS = 'resolvida' THEN 1 ELSE 0 END) AS RESOLVIDAS,
              ROUND(AVG(${SEG('c.ATRIBUIDA_EM', 'c.FILA_ENTROU_EM')})) AS ESPERA_MEDIA_SEG
         FROM MC_ZAP_CONVERSA c
         JOIN MC_ZAP_DEPARTAMENTO d ON d.ID = c.DEPARTAMENTO_ID
        ${where}
        GROUP BY d.ID, d.NOME, d.COR ORDER BY QTD DESC`,
      binds
    );

    const porAtendente = await conn.execute(
      `SELECT a.ID, a.NOME, a.MATRICULA, COUNT(*) AS QTD,
              SUM(CASE WHEN c.FILA_STATUS = 'resolvida' THEN 1 ELSE 0 END) AS RESOLVIDAS,
              SUM(CASE WHEN c.ORIGEM = 'ativa' THEN 1 ELSE 0 END) AS ATIVAS,
              SUM(CASE WHEN c.ORIGEM = 'receptiva' THEN 1 ELSE 0 END) AS RECEPTIVAS,
              ROUND(AVG(${SEG('c.PRIMEIRA_RESPOSTA_EM', 'c.ATRIBUIDA_EM')})) AS TMR_MEDIO_SEG,
              ROUND(AVG(${SEG('c.RESOLVIDA_EM', 'c.ATRIBUIDA_EM')})) AS DURACAO_MEDIA_SEG
         FROM MC_ZAP_CONVERSA c
         JOIN MC_ZAP_ATENDENTE a ON a.ID = c.ATENDENTE_ID
        ${where}
        GROUP BY a.ID, a.NOME, a.MATRICULA ORDER BY QTD DESC`,
      binds
    );

    // Quebra por dia + atendente (alimenta o tooltip do gráfico "por dia").
    // LEFT JOIN + NVL inclui conversas sem atendente (bot/fila) para a soma do
    // breakdown fechar com o total da barra do dia.
    const porDiaAtendente = await conn.execute(
      `SELECT TO_CHAR(TRUNC(c.CRIADO_EM), 'YYYY-MM-DD') AS DIA,
              NVL(a.NOME, 'Sem atendente') AS NOME,
              COUNT(*) AS QTD
         FROM MC_ZAP_CONVERSA c
         LEFT JOIN MC_ZAP_ATENDENTE a ON a.ID = c.ATENDENTE_ID
        ${where}
        GROUP BY TRUNC(c.CRIADO_EM), NVL(a.NOME, 'Sem atendente')
        ORDER BY DIA, QTD DESC`,
      binds
    );

    res.json({
      totais: mapRows(totais.rows)[0] || {},
      porDia: mapRows(porDia.rows),
      porDiaAtendente: mapRows(porDiaAtendente.rows),
      porDepto: mapRows(porDepto.rows),
      porAtendente: mapRows(porAtendente.rows),
    });
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
