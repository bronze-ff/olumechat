// utils/conviteLink.js — monta o link de "definir senha" a partir do slug do
// tenant + token em claro. Usado pelo provisionamento do operador (novo admin)
// e pela criação/reset de senha de atendentes pelo admin do próprio tenant —
// mesmo formato de link, mesma tela (client/src/pages/DefinirSenha.jsx).
'use strict';

function baseDoApp() {
  return String(process.env.APP_URL || 'http://localhost:3001').replace(/\/+$/, '');
}

function linkDeConvite(slug, token) {
  return `${baseDoApp()}/definir-senha?empresa=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`;
}

module.exports = { baseDoApp, linkDeConvite };
