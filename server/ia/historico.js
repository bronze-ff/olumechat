// server/ia/historico.js — persistência do histórico multi-turno do bot de IA
// (MC_ZAP_IA_TURNO). Formato neutro consumido/produzido pelo ia/client.js.
'use strict';
const db = require('../db/pool');

async function carregar(conn, conversaId) {
  // Ordena por (NUMERO_TURNO, ID): o ID (IDENTITY, monotônico na inserção) é o
  // tie-break determinístico caso dois turnos concorrentes recebam o mesmo número.
  const r = await conn.execute(
    `SELECT PAPEL, CONTEUDO, TOOL_JSON FROM MC_ZAP_IA_TURNO
      WHERE CONVERSA_ID = :c ORDER BY NUMERO_TURNO, ID`, { c: conversaId });
  return (r.rows || []).map((row) => {
    const base = { papel: row.PAPEL, texto: row.CONTEUDO || '' };
    if (row.TOOL_JSON) {
      const t = JSON.parse(row.TOOL_JSON);
      return { ...base, toolCallId: t.toolCallId, nome: t.nome, args: t.args, resultado: t.resultado };
    }
    return base;
  });
}

async function salvar(conn, conversaId, papel, dados = {}) {
  const rmax = await conn.execute(
    `SELECT NVL(MAX(NUMERO_TURNO),0) AS N FROM MC_ZAP_IA_TURNO WHERE CONVERSA_ID = :c`, { c: conversaId });
  const n = (rmax.rows[0].N || 0) + 1;
  const temTool = dados.toolCallId || dados.nome;
  const { oracledb } = db;
  // CONTEUDO/TOOL_JSON são CLOB: um resultado de tool grande estoura o limite de
  // bind VARCHAR se enviado como string crua — bind explícito como CLOB resolve.
  await conn.execute(
    `INSERT INTO MC_ZAP_IA_TURNO (CONVERSA_ID, NUMERO_TURNO, PAPEL, CONTEUDO, TOOL_JSON)
     VALUES (:c, :n, :papel, :conteudo, :tj)`,
    { c: conversaId, n, papel,
      conteudo: { val: dados.texto || '', type: oracledb.DB_TYPE_CLOB },
      tj: { val: temTool ? JSON.stringify({ toolCallId: dados.toolCallId, nome: dados.nome, args: dados.args, resultado: dados.resultado }) : null, type: oracledb.DB_TYPE_CLOB } });
}

module.exports = { carregar, salvar };
