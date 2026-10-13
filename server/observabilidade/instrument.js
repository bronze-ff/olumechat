'use strict';

// Primeiro módulo do processo. O @sentry/node só abre um escopo por
// requisição se o init rodar antes do Express, das rotas e do http.Server.
// Sem SENTRY_DSN, iniciar() não chama o SDK.

require('./sentry').iniciar();
