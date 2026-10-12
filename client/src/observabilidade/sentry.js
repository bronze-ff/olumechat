import * as Sentry from '@sentry/react';
import { DSN_SENTRY, AMBIENTE_SENTRY } from './env';
import { permitirEvento, permitirBreadcrumb, limparSpan } from './scrub';

let ativo = false;

function ambiente() {
  if (AMBIENTE_SENTRY === 'producao' || AMBIENTE_SENTRY === 'homologacao' || AMBIENTE_SENTRY === 'dev') {
    return AMBIENTE_SENTRY;
  }
  return import.meta.env.DEV ? 'dev' : 'producao';
}

function iniciarSentry() {
  if (!DSN_SENTRY || ativo) return ativo;
  Sentry.init({
    dsn: DSN_SENTRY,
    environment: ambiente(),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
      genAI: { inputs: false, outputs: false },
    },
    integrations: (lista) => lista.filter((item) => {
      const nome = item && item.name;
      return nome !== 'Replay' && nome !== 'BrowserSession' && !String(nome || '').includes('Replay');
    }),
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

function definirUsuarioSentry(id) {
  if (!DSN_SENTRY) return;
  if (!id) Sentry.setUser(null);
  else Sentry.setUser({ id: String(id) });
}

export { iniciarSentry, definirUsuarioSentry };
