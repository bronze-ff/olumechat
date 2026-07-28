// operador/erroOperador.js — erro de negócio do painel do operador, com
// status HTTP. Módulo próprio (sem outras dependências) para não criar
// ciclo de require entre operador/tenants.js, operador/credencialIa.js e
// ia/iaConfigStore.js (que precisa de operador/credencialIa.js para
// resolver a credencial global — FIL-78).
'use strict';

class ErroOperador extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
    this.deOperador = true;
  }
}

module.exports = { ErroOperador };
