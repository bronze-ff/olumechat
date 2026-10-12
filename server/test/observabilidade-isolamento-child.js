'use strict';

// Processo filho: o Sentry já foi inicializado por --import, antes deste
// arquivo dar require no Express. Não rode isto direto na suíte.

const express = require('express');
const Sentry = require('@sentry/node');
const { definirUsuario } = require('../observabilidade/sentry');

const app = express();

app.get('/set', async (req, res) => {
  definirUsuario(String(req.query.id));
  await new Promise((r) => setTimeout(r, 40));
  const visto = Sentry.getIsolationScope().getUser();
  res.json({ visto: visto && visto.id ? visto.id : null });
});

app.get('/ler', async (_req, res) => {
  await new Promise((r) => setTimeout(r, 15));
  const visto = Sentry.getIsolationScope().getUser();
  res.json({ visto: visto && visto.id ? visto.id : null });
});

const server = app.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const [a, b, c] = await Promise.all([
    fetch(`${base}/set?id=${encodeURIComponent('u:1')}`).then((r) => r.json()),
    fetch(`${base}/set?id=${encodeURIComponent('u:2')}`).then((r) => r.json()),
    fetch(`${base}/ler`).then((r) => r.json()),
  ]);
  const fora = Sentry.getIsolationScope().getUser();
  console.log(`ISOLAMENTO ${JSON.stringify({
    a,
    b,
    c,
    fora: fora && fora.id ? fora.id : null,
  })}`);
  process.exit(0);
});
