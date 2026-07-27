// webhook/routes.js — Endpoints do webhook da Cloud API.
//   GET  /webhook  → verificação (responde hub.challenge)
//   POST /webhook  → eventos (valida assinatura, responde 200 rápido, processa async)
const express = require('express');
const crypto = require('crypto');
const { rawBodyJson } = require('./rawBody');
const { isValidSignature } = require('./verifySignature');
const { processPayload } = require('./processEvent');
const { getConnection } = require('../db/pool');

/** Comparação de strings em tempo constante (anti timing attack). */
function igualSeguro(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function buildWebhookRouter(cfg) {
  const router = express.Router();

  // --- GET: verificação do webhook (PRD §5.3) ---
  router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && igualSeguro(token, cfg.verifyToken)) {
      console.log('[webhook] Verificação OK');
      return res.status(200).send(challenge);
    }
    console.warn('[webhook] Verificação FALHOU (token não confere)');
    return res.sendStatus(403);
  });

  // --- POST: recebimento de eventos ---
  router.post('/webhook', rawBodyJson, async (req, res) => {
    const signature = req.get('x-hub-signature-256');
    const ok = isValidSignature(req.rawBody, signature, cfg.appSecret);

    if (!ok) {
      console.warn('[webhook] Assinatura inválida — rejeitado');
      return res.sendStatus(401);
    }

    // Persiste o evento bruto e responde 200 IMEDIATAMENTE (< 250ms).
    let eventoId;
    try {
      eventoId = await logRawEvent(req.rawBody);
    } catch (err) {
      console.error('[webhook] Falha ao gravar evento bruto:', err.message);
      // Ainda assim respondemos 200 para evitar retries em loop; o evento
      // será reenviado pela Meta se necessário. Logamos para investigação.
    }
    res.sendStatus(200);

    // Processamento assíncrono (não bloqueia a resposta).
    setImmediate(async () => {
      try {
        await processPayload(req.body);
        if (eventoId) await markProcessed(eventoId, null);
      } catch (err) {
        console.error('[webhook] Erro processando evento:', err.message);
        if (eventoId) await markProcessed(eventoId, err.message).catch(() => {});
      }
    });
  });

  return router;
}

async function logRawEvent(rawBody) {
  const conn = await getConnection();
  try {
    const r = await conn.execute(
      `INSERT INTO MC_ZAP_EVENTO_WEBHOOK (PAYLOAD, ASSINATURA_OK)
       VALUES (:p, 'S') RETURNING ID INTO :id`,
      {
        p: rawBody.toString('utf8'),
        id: { type: require('oracledb').NUMBER, dir: require('oracledb').BIND_OUT },
      },
      { autoCommit: true }
    );
    return r.outBinds.id[0];
  } finally {
    await conn.close().catch(() => {});
  }
}

async function markProcessed(eventoId, erro) {
  const conn = await getConnection();
  try {
    await conn.execute(
      `UPDATE MC_ZAP_EVENTO_WEBHOOK
          SET PROCESSADO = :ok, ERRO = :erro WHERE ID = :id`,
      { ok: erro ? 'N' : 'S', erro: erro ? String(erro).slice(0, 4000) : null, id: eventoId },
      { autoCommit: true }
    );
  } finally {
    await conn.close().catch(() => {});
  }
}

module.exports = { buildWebhookRouter };
