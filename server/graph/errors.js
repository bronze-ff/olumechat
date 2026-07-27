// graph/errors.js — Tradução dos erros da Cloud API (Graph) para mensagens
// claras em português, exibíveis ao atendente. Os códigos seguem a referência
// oficial da Meta (Cloud API error codes). O texto cru fica no log; aqui só o
// que o usuário precisa entender e a ação recomendada.

// code -> mensagem amigável (já com a dica de ação quando útil).
const MENSAGENS = {
  // Janela / re-engajamento
  131047: 'Fora da janela de 24h: este cliente só pode ser contatado por um template aprovado.',
  131051: 'Tipo de mensagem não suportado para este contato.',
  // Limites / qualidade / frequência
  131048: 'Envio bloqueado pela avaliação de qualidade/spam do número. Aguarde e reduza o volume.',
  131049: 'A Meta limitou a entrega para este número agora (limite de engajamento saudável). Tente mais tarde.',
  131056: 'Muitas mensagens para este mesmo cliente em pouco tempo. Aguarde alguns minutos.',
  130429: 'Limite de envios por segundo atingido. Aguarde alguns instantes e tente novamente.',
  80007: 'Limite de taxa da conta atingido. Aguarde antes de enviar mais mensagens.',
  // Entregabilidade / número
  131026: 'Mensagem não entregável: o número pode não ter WhatsApp ou não aceita mensagens.',
  131021: 'Número de destino inválido ou igual ao número remetente.',
  133010: 'O número remetente não está registrado na Cloud API.',
  // Template
  132000: 'O número de variáveis enviado não confere com o template aprovado.',
  132001: 'Template inexistente ou não aprovado neste idioma.',
  132005: 'O texto final do template ficou longo demais (variáveis muito grandes).',
  132007: 'O conteúdo do template viola as políticas da Meta.',
  132012: 'Formato de uma variável do template está incorreto.',
  132015: 'Template pausado pela Meta por baixa qualidade.',
  132016: 'Template desabilitado pela Meta por violação de política.',
  // Conta / app / token
  368: 'Conta temporariamente bloqueada por violação de políticas da Meta.',
  190: 'Token de acesso expirado ou inválido — verifique a configuração do sistema.',
  10: 'Permissão insuficiente do app para esta ação.',
  200: 'Permissão insuficiente do app para esta ação.',
  100: 'Parâmetro inválido na requisição à Meta.',
  // Genéricos
  131000: 'Falha temporária na Meta ao processar a mensagem. Tente novamente.',
  131005: 'Acesso negado para esta operação.',
  133016: 'O número precisa ser registrado novamente na Cloud API.',
};

/**
 * Devolve a mensagem amigável para um código de erro da Meta.
 * @param {number|string} code  Código numérico do erro (err.code).
 * @param {string} [bruto]      Mensagem crua da Meta, usada como fallback.
 */
function mensagemAmigavel(code, bruto) {
  const n = Number(code);
  if (MENSAGENS[n]) return MENSAGENS[n];
  if (bruto) return `Erro da Meta (${code}): ${bruto}`;
  return `Não foi possível enviar pela Meta (código ${code || 'desconhecido'}).`;
}

module.exports = { MENSAGENS, mensagemAmigavel };
