// Teste do rate limit em GET /webhook (B7). Rota pública, sem autenticação —
// qualquer um na internet pode tentar adivinhar o WEBHOOK_VERIFY_TOKEN por
// força bruta; precisa de throttle básico por IP.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { buildWebhookRouter } = require('../webhook/routes');

const MAX = Number(process.env.WEBHOOK_VERIFY_RATE_LIMIT_MAX) || 30;

function startServer() {
  const app = express();
  const cfg = { verifyToken: 'verify123', appSecret: 'test_app_secret' };
  app.use('/', buildWebhookRouter(cfg));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function get(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', hostname: '127.0.0.1', port, path: '/webhook?hub.mode=subscribe&hub.verify_token=ERRADO&hub.challenge=X' },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); }
    );
    req.on('error', reject);
    req.end();
  });
}

test(`GET /webhook: acima de ${MAX} tentativas na janela → 429 (brute-force do verify token)`, async () => {
  const { server, port } = await startServer();
  try {
    for (let i = 0; i < MAX; i++) {
      const r = await get(port);
      assert.equal(r.status, 403, `tentativa ${i + 1} ainda deveria só recusar o token (403), não limitar`);
    }
    const limitada = await get(port);
    assert.equal(limitada.status, 429);
  } finally { server.close(); }
});
