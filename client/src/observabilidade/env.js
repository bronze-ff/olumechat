// Variáveis públicas do Vite. O acesso tem que ser estático:
// import.meta.env.VITE_* é substituído no build. Chave dinâmica não entra no bundle.

export const DSN_SENTRY = import.meta.env.VITE_SENTRY_DSN || '';
export const AMBIENTE_SENTRY = import.meta.env.VITE_SENTRY_ENVIRONMENT || '';
export const CHAVE_POSTHOG = import.meta.env.VITE_POSTHOG_KEY || '';
export const HOST_POSTHOG = import.meta.env.VITE_POSTHOG_HOST || '';
