'use strict';

// Sentry da API. Sem SENTRY_DSN o módulo não inicializa: dev, teste e build
// seguem sem rede e sem dependência do painel.
//
// Acesso estático às variáveis. Não leia process.env por chave dinâmica.

const Sentry = require('@sentry/node');
const { permitirEvento, permitirBreadcrumb, limparSpan } = require('./scrub');
const { idAceito } = require('./idSessao');

let ativo = false;

function ambiente() {
  const explicito = process.env.SENTRY_ENVIRONMENT;
  if (explicito === 'producao' || explicito === 'homologacao' || explicito === 'dev') {
    return explicito;
  }
  if (process.env.NODE_ENV === 'production') return 'producao';
  return 'dev';
}

function releaseAtual() {
  try {
    const v = require('../versao').versao();
    return v && v.sha ? v.sha : undefined;
  } catch {
    return undefined;
  }
}

function integracoes(lista) {
  return lista
    .filter((item) => {
      const nome = item && item.name;
      return nome !== 'Console' && nome !== 'LocalVariablesAsync' && nome !== 'LocalVariables';
    })
    .map((item) => {
      if (item && (item.name === 'Http.Server' || item.name === 'HttpServer')) {
        return Sentry.httpServerIntegration({ maxRequestBodySize: 'none' });
      }
      return item;
    });
}

function iniciar() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || ativo) return ativo;
  Sentry.init({
    dsn,
    environment: ambiente(),
    release: releaseAtual(),
    sendDefaultPii: false,
    includeLocalVariables: false,
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
    },
    integrations: integracoes,
    beforeSend(event) {
      return permitirEvento(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return permitirBreadcrumb(breadcrumb);
    },
    beforeSendSpan(span) {
      return limparSpan(span);
    },
  });
  ativo = true;
  return true;
}

function definirUsuario(id) {
  if (!ativo) return;
  // Escopo da requisição, não o escopo do processo. setUser() no escopo
  // padrão vaza o usuário de uma requisição para a seguinte.
  // Id que não seja inteiro positivo (e-mail, token forjado) não identifica.
  const escopo = Sentry.getIsolationScope();
  const aceito = idAceito(id);
  if (!aceito) escopo.setUser(null);
  else escopo.setUser({ id: aceito });
}

function registrarErroExpress(app) {
  if (!ativo) return;
  app.use(Sentry.expressErrorHandler());
}

module.exports = {
  iniciar,
  ativo: () => ativo,
  definirUsuario,
  registrarErroExpress,
};
