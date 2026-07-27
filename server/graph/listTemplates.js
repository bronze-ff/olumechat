// graph/listTemplates.js — Lista os templates da WABA na Graph API.
// Requer permissão whatsapp_business_management no token.
const { graphGet, cfg } = require('./client');

function parseBody(components) {
  const body = (components || []).find((c) => c.type === 'BODY');
  const text = body ? body.text : '';
  // Conta as variáveis {{1}}, {{2}}... distintas do corpo.
  const nums = new Set((text.match(/\{\{\s*\d+\s*\}\}/g) || []).map((m) => m.replace(/\D/g, '')));
  return { text, varCount: nums.size };
}

/** Devolve os templates APROVADOS, com corpo e nº de variáveis. */
async function listApprovedTemplates() {
  const res = await graphGet(
    `${cfg.wabaId}/message_templates?fields=name,status,language,category,components&limit=200`
  );
  const json = await res.json();
  return (json.data || [])
    .filter((t) => t.status === 'APPROVED')
    .map((t) => {
      const { text, varCount } = parseBody(t.components);
      return {
        name: t.name,
        language: t.language,
        category: t.category,
        body: text,
        varCount,
      };
    });
}

module.exports = { listApprovedTemplates };
