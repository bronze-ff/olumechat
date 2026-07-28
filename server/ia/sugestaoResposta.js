// server/ia/sugestaoResposta.js — rascunho de resposta para o ATENDENTE revisar
// e enviar (nunca sai sozinho pro cliente). Reusa o mesmo provedor/credencial
// do bot (ia_config), mas roda `semFerramentas`: é um texto sugerido, não uma
// ação — o atendente que decide o que vai pro cliente.
'use strict';
const client = require('./client');

const SISTEMA = 'Você ajuda um atendente de suporte via WhatsApp a redigir a PRÓXIMA resposta ao cliente. '
  + 'Escreva em português, tom cordial e objetivo, coerente com o histórico. Responda APENAS com o texto '
  + 'da mensagem sugerida — sem aspas, sem explicações, sem markdown. Se o histórico não tiver mensagem '
  + 'do cliente ainda pendente de resposta, sugira uma saudação inicial breve.';

const MAX_MENSAGENS = 12;

/** Últimas mensagens (texto) da conversa, sem notas internas — não expomos
    anotações internas do time para o provedor de IA externo. */
async function carregarContexto(conn, conversaId) {
  const r = await conn.execute(
    `SELECT direcao, conteudo FROM mensagem
      WHERE conversa_id = :id AND direcao IN ('in', 'out') AND conteudo IS NOT NULL
      ORDER BY ts DESC NULLS LAST, id DESC
      LIMIT :lim`,
    { id: conversaId, lim: MAX_MENSAGENS }
  );
  return r.rows.reverse().map((row) => ({
    papel: row.DIRECAO === 'in' ? 'user' : 'assistant',
    texto: row.CONTEUDO,
  }));
}

/** Gera a sugestão. Lança com mensagem amigável em vez de propagar o erro cru
    do provedor — quem chama (rota HTTP) só precisa exibir err.message. */
async function gerar(conn, config, conversaId) {
  const mensagens = await carregarContexto(conn, conversaId);
  if (!mensagens.length) throw new Error('Sem mensagens nesta conversa ainda para basear uma sugestão.');
  const out = await client.chamar({ config, sistema: SISTEMA, mensagens, semFerramentas: true });
  const texto = (out.texto || '').trim();
  if (!texto) throw new Error('O provedor não retornou uma sugestão.');
  return texto;
}

module.exports = { gerar };
