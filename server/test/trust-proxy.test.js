// Testes do "trust proxy" do Express (server/app.js) — FIL-93 (P0.7).
//
// Cadeia de produção: cliente → Cloudflare (borda) → Traefik (Coolify) →
// Express. São DOIS saltos de proxy confiáveis até o app: cada um AGREGA seu
// endereço percebido ao X-Forwarded-For (padrão de proxy reverso — Cloudflare
// grava o IP do cliente, Traefik acrescenta o IP que enxergou se conectando
// nele, que é a borda da Cloudflare). Com "trust proxy" errado, o rate limit
// por IP e a auditoria enxergam o IP de um proxy em vez do cliente real —
// no caso de "trust proxy: 1" (valor antigo, herdado do desenho anterior com
// IIS/ARR, um único hop), toda requisição apareceria vindo do MESMO IP de
// borda da Cloudflare, quebrando o rate limit por IP (webhook/routes.js,
// utils/rateLimitPorUsuario.js) e a auditoria (operador/auditoria.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

test('app.js configura "trust proxy" para 2 saltos (Cloudflare + Traefik)', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(
    appJs,
    /app\.set\(\s*['"]trust proxy['"]\s*,\s*2\s*\)/,
    'app.js deveria confiar em exatamente 2 saltos (Cloudflare → Traefik) na cadeia de produção'
  );
});

function appComTrustProxy(n) {
  const a = express();
  a.set('trust proxy', n);
  a.get('/ip', (req, res) => res.json({ ip: req.ip }));
  return a;
}

function getIp(port) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { method: 'GET', hostname: '127.0.0.1', port, path: '/ip',
        headers: { 'x-forwarded-for': '203.0.113.9, 172.18.0.4' } }, // cliente, borda Cloudflare
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve(JSON.parse(out || '{}')));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

test('trust proxy = 2 resolve o IP REAL do cliente numa cadeia X-Forwarded-For de 2 saltos', async () => {
  const srv = appComTrustProxy(2).listen(0);
  const port = srv.address().port;
  try {
    const { ip } = await getIp(port);
    assert.equal(ip, '203.0.113.9', 'deveria pular os 2 proxies confiáveis e chegar no cliente original');
  } finally { srv.close(); }
});

test('trust proxy = 1 (valor antigo) resolveria ERRADO nessa mesma cadeia — pega a borda da Cloudflare, não o cliente', async () => {
  const srv = appComTrustProxy(1).listen(0);
  const port = srv.address().port;
  try {
    const { ip } = await getIp(port);
    assert.equal(ip, '172.18.0.4', 'com só 1 salto confiável, o app para no IP da borda Cloudflare — todo tráfego pareceria vir do mesmo IP');
  } finally { srv.close(); }
});
