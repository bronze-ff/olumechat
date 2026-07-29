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
//
// FIL-85 — as duas dívidas apontadas na issue, e as duas nasceram do mesmo
// lugar: as ferramentas multiplicam turnos por mensagem (cada tool-call gera um
// turno `assistant` e um `tool`).
//
//   1. JANELA. O histórico inteiro ia ao provedor a CADA turno — custo direto,
//      crescendo para sempre dentro de uma conversa. Agora vão os últimos
//      MAX_TURNOS; o resto simplesmente não é enviado (fica no banco, é o
//      registro da conversa).
//
//   2. NÚMERO DO TURNO. Era `MAX+1` LIDO e depois inserido: duas mensagens no
//      mesmo instante geravam o MESMO número. Agora o número sai de uma
//      subconsulta dentro do próprio INSERT, com ON CONFLICT DO NOTHING (o
//      índice único entrou na migração 022) e um retry curto — quem perder a
//      corrida tenta de novo e pega o número seguinte.
'use strict';

/** Últimos turnos enviados ao provedor. 40 cabe uma conversa longa de verdade
 *  (dezenas de mensagens + tool-calls) e ainda assim põe um teto no custo por
 *  turno. Gatilho para reconsiderar (spec): conversa real perdendo contexto. */
const MAX_TURNOS = 40;

/** Tentativas do INSERT em corrida. Perder duas vezes seguidas exigiria três
 *  turnos gravados no mesmo milissegundo para a mesma conversa; a terceira
 *  tentativa é folga, não expectativa. */
const MAX_TENTATIVAS = 5;

/**
 * A janela não pode cortar em qualquer lugar. Duas exigências dos provedores, e
 * quebrar qualquer uma vira 400 — que o runtime transforma na resposta genérica
 * de indisponível. Numa conversa longa isso aconteceria em TODO turno.
 *
 *   - A PRIMEIRA mensagem tem que ser do `user` (a Anthropic recusa um array
 *     que comece em `assistant`). Como um turno `tool` também não abre conversa
 *     (vira `tool_result` órfão: "tool_result without tool_use" na Anthropic,
 *     `role:tool` sem `tool_calls` antes na OpenAI), a regra das duas vira uma
 *     só: **o recorte começa no primeiro turno `user`**. Isso preserva os pares
 *     tool_use/tool_result de graça — o par sempre nasce depois de uma fala do
 *     cliente, então nenhum par fica partido ao avançar até um `user`.
 *   - O FIM não pode ser um `assistant` com tool-call sem o resultado dele (só
 *     acontece se o processo morrer entre gravar a chamada e gravar o retorno).
 *
 * O runtime SEMPRE grava o turno `user` da mensagem que está sendo respondida
 * antes de carregar o histórico, então há sempre pelo menos um `user` dentro da
 * janela dos últimos MAX_TURNOS.
 */
function aparar(turnos) {
  let ini = 0;
  while (ini < turnos.length && turnos[ini].papel !== 'user') ini += 1;
  let fim = turnos.length;
  while (fim > ini && turnos[fim - 1].papel === 'assistant' && turnos[fim - 1].toolCallId) fim -= 1;
  return turnos.slice(ini, fim);
}

async function carregar(conn, tenantId, conversaId) {
  // Ordena por (NUMERO_TURNO, ID): o ID (IDENTITY, monotônico na inserção) é o
  // tie-break determinístico caso dois turnos concorrentes recebam o mesmo número.
  // A janela é pega pelo FIM (DESC + LIMIT) e reinvertida — pegar do começo
  // mandaria ao provedor o início de uma conversa que já não interessa.
  const r = await conn.execute(
    `SELECT PAPEL, CONTEUDO, TOOL_JSON, MIDIA_CAMINHO, MIDIA_MIME FROM (
       SELECT PAPEL, CONTEUDO, TOOL_JSON, MIDIA_CAMINHO, MIDIA_MIME, NUMERO_TURNO, ID
         FROM ia_turno
        WHERE tenant_id = :tenantId AND CONVERSA_ID = :c
        ORDER BY NUMERO_TURNO DESC, ID DESC
        LIMIT :limite
     ) ultimos ORDER BY NUMERO_TURNO, ID`,
    { tenantId, c: conversaId, limite: MAX_TURNOS });
  const turnos = (r.rows || []).map((row) => {
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
  return aparar(turnos);
}

async function salvar(conn, tenantId, conversaId, papel, dados = {}) {
  const temTool = dados.toolCallId || dados.nome;
  const tj = temTool
    ? JSON.stringify({ toolCallId: dados.toolCallId, nome: dados.nome, args: dados.args, resultado: dados.resultado })
    : (dados.aviso ? JSON.stringify({ aviso: dados.aviso }) : null);
  const binds = {
    tenantId, c: conversaId, papel,
    conteudo: dados.texto || '',
    tj,
    cam: dados.midiaCaminho || null,
    mime: dados.midiaMime || null,
  };

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa += 1) {
    // O número sai de uma SUBCONSULTA do próprio INSERT — não há mais leitura
    // e escrita separadas. ON CONFLICT sem alvo de propósito: com o índice
    // único da migração 022 ele absorve a corrida; num ambiente com a migração
    // ainda pendente o INSERT simplesmente passa (comportamento de antes),
    // em vez de estourar 42P10 e abortar a transação que responde ao cliente.
    const r = await conn.execute(
      `INSERT INTO ia_turno (tenant_id, CONVERSA_ID, NUMERO_TURNO, PAPEL, CONTEUDO, TOOL_JSON, MIDIA_CAMINHO, MIDIA_MIME)
       SELECT :tenantId, :c, COALESCE(MAX(NUMERO_TURNO), 0) + 1, :papel, :conteudo, :tj, :cam, :mime
         FROM ia_turno WHERE tenant_id = :tenantId AND CONVERSA_ID = :c
       ON CONFLICT DO NOTHING`,
      binds);
    if (r.rowsAffected) return;
  }
  // Cinco corridas perdidas seguidas não é concorrência: é sintoma. Logar e
  // seguir — perder UM turno de histórico é ruim, derrubar o atendimento é pior.
  console.error(`[ia] não consegui gravar o turno da conversa ${conversaId} (${MAX_TENTATIVAS} tentativas)`);
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

module.exports = { carregar, salvar, jaAvisou, MAX_TURNOS };
