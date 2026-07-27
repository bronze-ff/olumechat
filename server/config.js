// config.js — Carrega e valida variáveis de ambiente (fail-fast).
require('dotenv').config();

const REQUIRED = [
  'META_APP_SECRET',
  'WEBHOOK_VERIFY_TOKEN',
  'WA_TOKEN',
  'WA_PHONE_NUMBER_ID',
  'WA_BUSINESS_ACCOUNT_ID',
  'ORACLE_USER',
  'ORACLE_PASSWORD',
  'ORACLE_CONNECT_STRING',
];

function loadConfig({ requireDb = true } = {}) {
  const required = requireDb
    ? REQUIRED
    : REQUIRED.filter((k) => !k.startsWith('ORACLE_'));

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
    waToken:       process.env.WA_TOKEN,
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
    wabaId:        process.env.WA_BUSINESS_ACCOUNT_ID,
    graphVersion:  process.env.GRAPH_VERSION || 'v21.0',
    mediaDir:      process.env.MEDIA_DIR || require('path').join(process.cwd(), 'media'),
    conhecimentoDir: process.env.CONHECIMENTO_DIR || require('path').join(process.cwd(), 'conhecimento'),
    github: {
      owner: process.env.GITHUB_OWNER || 'MulticanalAtacado',
      repo: process.env.GITHUB_REPO || 'mc-OS',
      ref: process.env.GITHUB_REF || 'main',
      token: process.env.GITHUB_TOKEN || null,
    },
    oracle: {
      user:          process.env.ORACLE_USER,
      password:      process.env.ORACLE_PASSWORD,
      connectString: process.env.ORACLE_CONNECT_STRING,
      libDir:        process.env.ORACLE_LIB_DIR,
    },
  };
}

module.exports = { loadConfig };
