// webhook/routes.js — Endpoints do webhook da Cloud API.
//
//   GET  /webhook                  → verificação (responde hub.challenge)
//   POST /webhook                  → eventos do app da PLATAFORMA (META_APP_SECRET)
//   GET  /webhook/:identificador   → verificação do app DO CLIENTE
//   POST /webhook/:identificador   → eventos do app DO CLIENTE (App Secret dele)
//
// ⚠️ FIL-94 (docs/DEPLOY_VPS.md §P0.6): a ordem aqui é o ticket inteiro. O
// evento bruto é gravado ANTES do ACK; só então respondemos 200 e processamos
// fora do ciclo da resposta. Se a gravação falhar, respondemos 503 — erro
// recuperável, que faz a Meta REENVIAR. O contrário (200 e processar em
// memória) era o bug: um restart no instante seguinte perdia a mensagem do
// cliente sem deixar rastro. Ver webhook/durabilidade.js.
//
// ⚠️ FIL-97 — DOIS MODELOS CONVIVEM, E O DE BAIXO NÃO MUDA O DE CIMA. Enquanto
// a Olume não tem CNPJ (logo, nenhum app verificado próprio), cada cliente usa o
// app DELE, com App Secret próprio. Como a assinatura é HMAC do corpo com esse
// segredo, é preciso saber de quem é a requisição ANTES de validar — e o corpo
// ainda não é confiável. Quem resolve isso é o CAMINHO: `/webhook/<32 hex>`
// identifica o tenant antes de qualquer parsing. O `/webhook` sem sufixo segue
// exatamente como estava, com o segredo global — é por onde entram os clientes
// de Embedded Signup quando a Olume tiver app próprio. Ver meta/appCliente.js.
//
// As duas variantes compartilham o MESMO pipeline durável (`entregar`): o que
// muda é só qual segredo valida a assinatura e se o evento fica amarrado a um
// tenant.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { rawBodyJson } = require('./rawBody');
const { isValidSignature } = require('./verifySignature');
const durabilidade = require('./durabilidade');
const appCliente = require('../meta/appCliente');

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

  /**
   * O pipeline durável, compartilhado pelas duas variantes de POST. A
   * assinatura JÁ foi validada por quem chama — é a única coisa que difere
   * entre elas (segredo global x segredo do cliente).
   * @param {number|null} tenantId dono do caminho, ou null no webhook global
   */
  async function entregar(req, res, tenantId) {
    // 1) DURABILIDADE ANTES DO ACK. Uma gravação, com chave idempotente.
    let evento;
    try {
      evento = await durabilidade.receber(req.rawBody, req.body, { tenantId });
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
      durabilidade.processar(evento.id, req.body, { tenantEsperado: tenantId }).catch((err) => {
        console.error('[webhook] Erro processando evento:', err.message);
      });
    });
  }

  // --- POST: recebimento de eventos (app da PLATAFORMA) ---
  router.post('/webhook', rawBodyJson, async (req, res) => {
    const signature = req.get('x-hub-signature-256');
    const ok = isValidSignature(req.rawBody, signature, cfg.appSecret);

    if (!ok) {
      console.warn('[webhook] Assinatura inválida — rejeitado');
      return res.sendStatus(401);
    }
    return entregar(req, res, null);
  });

  // --- Webhook POR CLIENTE (FIL-97) ---
  //
  // Rota pública que faz UMA consulta ao banco por requisição para achar o dono
  // do caminho. O formato fechado (32 hex) já barra a maior parte do lixo de
  // scanner ANTES do banco; este limitador cobre o resto, contando SÓ as
  // respostas de erro do cliente (4xx). Tráfego legítimo da Meta responde 200 e
  // nunca é contado — e 503 (banco fora) também não, senão uma queda
  // transitória viraria bloqueio da Meta logo depois dela voltar.
  const caminhoLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.WEBHOOK_CAMINHO_RATE_LIMIT_MAX) || 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: chavePorIp,
    validate: { trustProxy: false },
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.statusCode >= 500,
  });

  /** Resolve o dono do caminho. Devolve `{ conexao }`, `{ naoEncontrado: true }`
      ou `{ erro }` — os três têm resposta HTTP diferente e colapsá-los faria a
      Meta desistir de reenviar numa queda transitória do banco. */
  async function donoDoCaminho(identificador) {
    if (!appCliente.identificadorValido(identificador)) return { naoEncontrado: true };
    try {
      const conexao = await appCliente.resolverPorIdentificador(identificador);
      return conexao ? { conexao } : { naoEncontrado: true };
    } catch (err) {
      return { erro: err };
    }
  }

  // --- GET /webhook/:identificador: verificação da Meta no app do cliente ---
  // O verify token continua GLOBAL de propósito: ele só prova que quem cadastrou
  // o webhook fala com a Olume, e o caminho já é exclusivo daquele cliente.
  // Quem autentica evento de verdade é a assinatura HMAC do POST.
  router.get('/webhook/:identificador', verificacaoLimiter, async (req, res) => {
    const r = await donoDoCaminho(req.params.identificador);
    if (r.erro) {
      console.error('[webhook] verificação por caminho falhou ao resolver o cliente:', r.erro.message);
      return res.sendStatus(503);
    }
    // 404 seco: um caminho desconhecido não revela se o cliente existe, se o
    // app dele está configurado, nem que este endereço é um webhook.
    if (r.naoEncontrado) return res.sendStatus(404);

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    if (mode === 'subscribe' && igualSeguro(token, cfg.verifyToken)) {
      console.log(`[webhook] Verificação OK (tenant ${r.conexao.tenantId})`);
      return res.status(200).send(req.query['hub.challenge']);
    }
    console.warn('[webhook] Verificação FALHOU (token não confere)');
    return res.sendStatus(403);
  });

  // --- POST /webhook/:identificador: eventos assinados com o segredo do cliente ---
  router.post('/webhook/:identificador', caminhoLimiter, rawBodyJson, async (req, res) => {
    const r = await donoDoCaminho(req.params.identificador);
    if (r.erro) {
      // Não sabemos de quem é nem se a assinatura confere: 503 faz a Meta
      // reenviar. 404 aqui descartaria a mensagem do cliente de vez.
      console.error('[webhook] falha ao resolver o cliente do caminho:', r.erro.message);
      return res.status(503).json({ error: 'indisponivel' });
    }
    if (r.naoEncontrado) return res.sendStatus(404);

    const signature = req.get('x-hub-signature-256');
    if (!isValidSignature(req.rawBody, signature, r.conexao.appSecret)) {
      // Com o segredo do CLIENTE: uma assinatura feita com o segredo de outro
      // cliente (ou com o global) não passa aqui.
      console.warn(`[webhook] Assinatura inválida no caminho do tenant ${r.conexao.tenantId} — rejeitado`);
      return res.sendStatus(401);
    }
    // O tenant amarrado ao evento é o do CAMINHO, não o do corpo: a assinatura
    // só prova a origem, nunca o conteúdo (ver processEvent::tenantEsperado).
    return entregar(req, res, r.conexao.tenantId);
  });

  return router;
}

module.exports = { buildWebhookRouter };
