// server/ia/historico.js — persistência do histórico multi-turno do bot de IA
// (ia_turno, 1 linha por turno, por tenant). Formato neutro consumido/produzido
// pelo ia/client.js. CONTEUDO era CLOB no Oracle → text; TOOL_JSON → jsonb (o
// pg aceita string JSON num bind de coluna jsonb sem spec de tipo — ver sql.js).
'use strict';

async function carregar(conn, tenantId, conversaId) {
  // Ordena por (NUMERO_TURNO, ID): o ID (IDENTITY, monotônico na inserção) é o
  // tie-break determinístico caso dois turnos concorrentes recebam o mesmo número.
  const r = await conn.execute(
    `SELECT PAPEL, CONTEUDO, TOOL_JSON FROM ia_turno
      WHERE tenant_id = :tenantId AND CONVERSA_ID = :c ORDER BY NUMERO_TURNO, ID`,
    { tenantId, c: conversaId });
  return (r.rows || []).map((row) => {
    const base = { papel: row.PAPEL, texto: row.CONTEUDO || '' };
    if (row.TOOL_JSON) {
      const t = typeof row.TOOL_JSON === 'string' ? JSON.parse(row.TOOL_JSON) : row.TOOL_JSON;
      return { ...base, toolCallId: t.toolCallId, nome: t.nome, args: t.args, resultado: t.resultado };
    }
    return base;
  });
}

async function salvar(conn, tenantId, conversaId, papel, dados = {}) {
  const rmax = await conn.execute(
    `SELECT COALESCE(MAX(NUMERO_TURNO),0) AS N FROM ia_turno WHERE tenant_id = :tenantId AND CONVERSA_ID = :c`,
    { tenantId, c: conversaId });
  const n = (rmax.rows[0].N || 0) + 1;
  const temTool = dados.toolCallId || dados.nome;
  await conn.execute(
    `INSERT INTO ia_turno (tenant_id, CONVERSA_ID, NUMERO_TURNO, PAPEL, CONTEUDO, TOOL_JSON)
     VALUES (:tenantId, :c, :n, :papel, :conteudo, :tj)`,
    { tenantId, c: conversaId, n, papel,
      conteudo: dados.texto || '',
      tj: temTool ? JSON.stringify({ toolCallId: dados.toolCallId, nome: dados.nome, args: dados.args, resultado: dados.resultado }) : null });
}

module.exports = { carregar, salvar };
