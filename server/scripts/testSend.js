// scripts/testSend.js — Chamada de teste da Graph API (checklist item 10 do PRD).
// NÃO precisa de Oracle (só dispara a mensagem e imprime a resposta).
//
// Uso:
//   node src/scripts/testSend.js text     5511999998888 "Olá, teste MC-Zap"
//   node src/scripts/testSend.js template 5511999998888 nome_do_template pt_BR "Fulano" "150,00" "10/06/2026"
//
// Para um número NOVO que nunca falou com o seu, só TEMPLATE é entregue
// (janela de 24h fechada). Texto livre só funciona com janela aberta.
require('dotenv').config();

async function main() {
  const [, , kind, to, ...rest] = process.argv;

  if (!kind || !to) {
    console.error('Uso: node src/scripts/testSend.js <text|template> <telefone E.164 sem +> ...');
    process.exit(1);
  }

  try {
    if (kind === 'text') {
      const { sendText } = require('../graph/sendText');
      const body = rest.join(' ') || 'Mensagem de teste — MC-Zap';
      const r = await sendText(to, body);
      console.log('OK (text):', JSON.stringify(r, null, 2));
    } else if (kind === 'template') {
      const { sendTemplate } = require('../graph/sendTemplate');
      const [templateName, lang = 'pt_BR', ...params] = rest;
      if (!templateName) {
        console.error('Faltou o nome do template.');
        process.exit(1);
      }
      const r = await sendTemplate(to, templateName, lang, params);
      console.log('OK (template):', JSON.stringify(r, null, 2));
    } else {
      console.error(`Tipo desconhecido: ${kind}. Use "text" ou "template".`);
      process.exit(1);
    }
  } catch (err) {
    console.error('FALHA:', err.message);
    process.exit(1);
  }
}

main();
