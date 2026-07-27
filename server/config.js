// config.js — Carrega e valida variáveis de ambiente (fail-fast).
require('dotenv').config();

const REQUIRED = [
  'META_APP_SECRET',
  'WEBHOOK_VERIFY_TOKEN',
  'DATABASE_URL',
];

const DB_VARS = ['DATABASE_URL'];

function loadConfig({ requireDb = true } = {}) {
  const required = requireDb
    ? REQUIRED
    : REQUIRED.filter((k) => !DB_VARS.includes(k));

  const missing = required.filter((k) => !process.env[k] || !process.env[k].trim());
  if (missing.length) {
    console.error(`[config] Variáveis de ambiente faltando: ${missing.join(', ')}`);
    console.error('[config] Copie .env.example para .env e preencha.');
    process.exit(1);
  }

  return {
    port:          Number(process.env.PORT) || 3001,
    nodeEnv:       process.env.NODE_ENV || 'development',
    appSecret:     process.env.META_APP_SECRET,
    verifyToken:   process.env.WEBHOOK_VERIFY_TOKEN,
    // Fallback exclusivo de desenvolvimento legado; produção resolve por tenant.
    devMetaFallback: process.env.NODE_ENV !== 'production',
    waToken:       process.env.NODE_ENV !== 'production' ? process.env.WA_TOKEN : undefined,
    phoneNumberId: process.env.NODE_ENV !== 'production' ? process.env.WA_PHONE_NUMBER_ID : undefined,
    wabaId:        process.env.NODE_ENV !== 'production' ? process.env.WA_BUSINESS_ACCOUNT_ID : undefined,
    metaAppId:     process.env.META_APP_ID,
    graphVersion:  process.env.GRAPH_VERSION || 'v21.0',
    mediaDir:      process.env.MEDIA_DIR || require('path').join(process.cwd(), 'media'),
    conhecimentoDir: process.env.CONHECIMENTO_DIR || require('path').join(process.cwd(), 'conhecimento'),
    github: {
      owner: process.env.GITHUB_OWNER || 'MulticanalAtacado',
      repo: process.env.GITHUB_REPO || 'mc-OS',
      ref: process.env.GITHUB_REF || 'main',
      token: process.env.GITHUB_TOKEN || null,
    },
    // Connection string POOLED do Neon (PgBouncer em transaction mode).
    databaseUrl: process.env.DATABASE_URL,
  };
}

module.exports = { loadConfig };
