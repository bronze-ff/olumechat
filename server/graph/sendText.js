// graph/sendText.js — Envio de mensagem de TEXTO LIVRE.
// Só é entregue se a janela de 24h estiver aberta (cliente falou nas últimas 24h).
// Fora da janela, a Meta rejeita — use sendTemplate.
const { sendMessage } = require('./client');

/**
 * @param {string} to             Telefone destino em E.164 sem '+', ex: '5511999998888'.
 * @param {string} text           Conteúdo da mensagem.
 * @param {string} [phoneNumberId] Número de origem (multi-número); default = .env.
 */
async function sendText(to, text, phoneNumberId) {
  return sendMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text },
  }, phoneNumberId);
}

module.exports = { sendText };
