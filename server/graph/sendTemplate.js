// graph/sendTemplate.js — Envio de mensagem de TEMPLATE pré-aprovado.
// Usado para INICIAR conversa (fora da janela de 24h) — caso da cobrança.
const { sendMessage } = require('./client');

/**
 * @param {string} to            Telefone destino E.164 sem '+'.
 * @param {string} templateName  Nome do template aprovado na Meta.
 * @param {string} lang          Código de idioma, ex: 'pt_BR'.
 * @param {string[]} bodyParams  Valores das variáveis {{1}},{{2}}... do corpo (ordem importa).
 * @param {string} [phoneNumberId] Número de origem (multi-número); default = .env.
 */
async function sendTemplate(to, templateName, lang = 'pt_BR', bodyParams = [], phoneNumberId) {
  const components = [];
  if (bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })),
    });
  }

  return sendMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      ...(components.length ? { components } : {}),
    },
  }, phoneNumberId);
}

module.exports = { sendTemplate };
