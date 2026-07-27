// webhook/rawBody.js — Parser JSON que PRESERVA o corpo bruto.
// A validação X-Hub-Signature-256 exige o byte-a-byte exato do corpo,
// ANTES de qualquer reserialização. Por isso capturamos `req.rawBody`.
const express = require('express');

const rawBodyJson = express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf; // Buffer cru, usado no HMAC
  },
});

module.exports = { rawBodyJson };
