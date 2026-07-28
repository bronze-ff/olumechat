// server/ia/historico.js — persistência do histórico multi-turno do bot de IA
// (ia_turno, 1 linha por turno, por tenant). Formato neutro consumido/produzido
// pelo ia/client.js. CONTEUDO era CLOB no Oracle → text; TOOL_JSON → jsonb (o
// pg aceita string JSON num bind de coluna jsonb sem spec de tipo — ver sql.js).
//
// FIL-84: o turno passa a carregar a MÍDIA que chegou — o CAMINHO no storage,
// nunca os bytes (ia/anexos.js decide o que reanexar a cada turno; guardar
// binário aqui inflaria a tabela e o custo). E `tool_json.aviso` marca a
// resposta educada de tipo não suportado, para ela sair UMA vez por tipo por
// conversa em vez de a cada vídeo que o cliente mandar.
'use strict';

async function carregar(conn, tenantId, conversaId) {
  // Ordena por (NUMERO_TURNO, ID): o ID (IDENTITY, monotônico na inserção) é o
  // tie-break determinístico caso dois turnos concorrentes recebam o mesmo número.
  const r = await conn.execute(
    `SELECT PAPEL, CONTEUDO, TOOL_JSON, MIDIA_CAMINHO, MIDIA_MIME FROM ia_turno
      WHERE tenant_id = :tenantId AND CONVERSA_ID = :c ORDER BY NUMERO_TURNO, ID`,
    { tenantId, c: conversaId });
  return (r.rows || []).map((row) => {
    const base = {
      papel: row.PAPEL,
      texto: row.CONTEUDO || '',
      midiaCaminho: row.MIDIA_CAMINHO || null,
      midiaMime: row.MIDIA_MIME || null,
    };
    if (row.TOOL_JSON) {
      const t = typeof row.TOOL_JSON === 'string' ? JSON.parse(row.TOOL_JSON) : row.TOOL_JSON;
      // Turno de AVISO (tool_json.aviso) não é tool-call: não tem toolCallId
      // nem nome, e o client.js o trata como assistant de texto puro.
      if (t && (t.toolCallId || t.nome)) {
        return { ...base, toolCallId: t.toolCallId, nome: t.nome, args: t.args, resultado: t.resultado };
      }
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
  const tj = temTool
    ? JSON.stringify({ toolCallId: dados.toolCallId, nome: dados.nome, args: dados.args, resultado: dados.resultado })
    : (dados.aviso ? JSON.stringify({ aviso: dados.aviso }) : null);
  await conn.execute(
    `INSERT INTO ia_turno (tenant_id, CONVERSA_ID, NUMERO_TURNO, PAPEL, CONTEUDO, TOOL_JSON, MIDIA_CAMINHO, MIDIA_MIME)
     VALUES (:tenantId, :c, :n, :papel, :conteudo, :tj, :cam, :mime)`,
    { tenantId, c: conversaId, n, papel,
      conteudo: dados.texto || '',
      tj,
      cam: dados.midiaCaminho || null,
      mime: dados.midiaMime || null });
}

/** Esta conversa JÁ recebeu a resposta educada para este tipo de mídia?
 *  Sem esta marca, um cliente que manda cinco vídeos seguidos recebe cinco
 *  vezes "me manda por texto" — insuportável. */
async function jaAvisou(conn, tenantId, conversaId, tipo) {
  const r = await conn.execute(
    `SELECT 1 AS N FROM ia_turno
      WHERE tenant_id = :tenantId AND CONVERSA_ID = :c AND tool_json->>'aviso' = :tipo
      LIMIT 1`,
    { tenantId, c: conversaId, tipo });
  return Boolean(r.rows && r.rows.length);
}

module.exports = { carregar, salvar, jaAvisou };
