// utils/descreverMensagem.js — Texto amigável (PT-BR) para tipos de mensagem do
// WhatsApp que NÃO são texto puro nem mídia (system, reaction, button, interactive,
// order, etc.) e também contatos/localização. Centraliza a renderização usada no
// recebimento (webhook) e no backfill, evitando gravar JSON cru no histórico.
//
// Devolve texto CRU (com emoji/acento) e é gravado assim no banco: o Postgres é
// UTF-8, sem o workaround de charset que o Oracle exigia.
'use strict';

/**
 * @param {string} tipo   o msg.type do WhatsApp (system, reaction, button, ...)
 * @param {*}      dados   o objeto específico do tipo: msg[tipo]
 * @returns {string} texto amigável para exibir no chat
 */
function descreverMensagem(tipo, dados) {
  const d = dados || {};
  switch (tipo) {
    case 'reaction':
      return d.emoji ? `reagiu com ${d.emoji}` : 'removeu a reação';

    case 'button': // resposta de quick-reply de template
      return d.text || 'Resposta de botão';

    case 'interactive': { // resposta de menu/lista (fluxos interativos)
      if (d.type === 'button_reply' && d.button_reply) return d.button_reply.title || 'Opção selecionada';
      if (d.type === 'list_reply' && d.list_reply) return d.list_reply.title || 'Item selecionado';
      return 'Resposta interativa';
    }

    case 'system': { // eventos de sistema (troca de número, etc.)
      if (d.type === 'user_changed_number' || d.type === 'customer_changed_number') return '📱 Cliente trocou de número.';
      if (d.type === 'customer_identity_changed') return '🔐 Identidade do cliente alterada.';
      return d.body || 'Mensagem do sistema.';
    }

    case 'order': { // pedido via catálogo
      const itens = Array.isArray(d.product_items) ? d.product_items : [];
      const qtd = itens.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
      const total = itens.reduce((s, p) => s + (Number(p.quantity) || 0) * (Number(p.item_price) || 0), 0);
      const moeda = (itens[0] && itens[0].currency) || 'BRL';
      let tot = '';
      try { if (total) tot = ` — ${total.toLocaleString('pt-BR', { style: 'currency', currency: moeda })}`; } catch { tot = ''; }
      return `🛒 Pedido: ${qtd} item(ns)${tot}`;
    }

    case 'request_welcome':
      return 'Cliente abriu a conversa.';

    case 'unsupported':
      return '⚠️ Mensagem não suportada pelo WhatsApp.';

    case 'contacts': { // cartão(ões) de contato compartilhado(s) — dados é um array
      const arr = Array.isArray(dados) ? dados : [];
      if (!arr.length) return '📇 Contato compartilhado.';
      return arr.map((c) => {
        const nm = (c.name && (c.name.formatted_name || c.name.first_name)) || 'contato';
        const fones = (c.phones || []).map((p) => p.phone).filter(Boolean).join(', ');
        return `📇 Contato compartilhado: ${nm}${fones ? ' — ' + fones : ''}`;
      }).join('\n');
    }

    case 'location': {
      const l = d;
      return `📍 Localização${l.name ? ' — ' + l.name : ''} (${l.latitude}, ${l.longitude})`;
    }

    default:
      return `Mensagem do tipo "${tipo}"`;
  }
}

module.exports = { descreverMensagem };
