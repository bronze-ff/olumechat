// webhook/routes.js — Endpoints do webhook da Cloud API.
//   GET  /webhook  → verificação (responde hub.challenge)
//   POST /webhook  → eventos (valida assinatura, PERSISTE, responde 200, processa async)
//
// ⚠️ FIL-94 (docs/DEPLOY_VPS.md §P0.6): a ordem aqui é o ticket inteiro. O
// evento bruto é gravado ANTES do ACK; só então respondemos 200 e processamos
// fora do ciclo da resposta. Se a gravação falhar, respondemos 503 — erro
// recuperável, que faz a Meta REENVIAR. O contrário (200 e processar em
// memória) era o bug: um restart no instante seguinte perdia a mensagem do
// cliente sem deixar rastro. Ver webhook/durabilidade.js.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { rawBodyJson } = require('./rawBody');
const { isValidSignature } = require('./verifySignature');
const durabilidade = require('./durabilidade');

/** Comparação de strings em tempo constante (anti timing attack). */
function igualSeguro(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Atrás de um proxy o X-Forwarded-For pode chegar com PORTA e a lib rejeita
// (ERR_ERL_INVALID_IP_ADDRESS). Mesmo tratamento do auth/routes.js.
function chavePorIp(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return m ? m[1] : ip;
}

function buildWebhookRouter(cfg) {
  const router = express.Router();

  // Rota pública, sem autenticação: qualquer um na internet pode tentar
  // adivinhar o WEBHOOK_VERIFY_TOKEN por força bruta. Throttle básico por IP —
  // a Meta só chama isto na configuração inicial do webhook, então não há
  // tráfego legítimo de alta frequência para acomodar aqui.
  const verificacaoLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.WEBHOOK_VERIFY_RATE_LIMIT_MAX) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: chavePorIp,
    validate: { trustProxy: false },
  });

  // --- GET: verificação do webhook (PRD §5.3) ---
  router.get('/webhook', verificacaoLimiter, (req, res) => {
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

    // 1) DURABILIDADE ANTES DO ACK. Uma gravação, com chave idempotente.
    let evento;
    try {
      evento = await durabilidade.receber(req.rawBody, req.body);
    } catch (err) {
      // Não conseguimos garantir a mensagem: 503 faz a Meta reenviar. Responder
      // 200 aqui seria descartar a mensagem do cliente silenciosamente.
      console.error('[webhook] Falha ao gravar evento bruto — pedindo reenvio à Meta:', err.message);
      return res.status(503).json({ error: 'indisponivel' });
    }

    // 2) ACK. A partir daqui o evento existe no banco: mesmo que o processo
    //    morra agora, a varredura de recuperação o retoma.
    res.sendStatus(200);

    // 3) Reentrega da Meta (mesma chave) já está gravada e processada/em
    //    processamento — repetir o pipeline só duplicaria trabalho.
    if (evento.duplicado) {
      console.log('[webhook] evento reentregue pela Meta — já registrado, nada a fazer');
      return;
    }

    // 4) Processamento fora do ciclo da resposta (não bloqueia o ACK).
    setImmediate(() => {
      durabilidade.processar(evento.id, req.body).catch((err) => {
        console.error('[webhook] Erro processando evento:', err.message);
      });
    });
  });

  return router;
}

module.exports = { buildWebhookRouter };
