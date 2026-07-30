// api/leads.js — POST /api/leads (FIL-96): o formulário público da landing
// grava o lead no banco em vez de só montar um `mailto:` que morre sem
// cliente de e-mail configurado.
//
// SEM AUTENTICAÇÃO DE PROPÓSITO — é a landing, ninguém logou ainda. Três
// defesas de rota pública:
//   • rate limit por IP (mesmo padrão de auth/routes.js e operador/routes.js);
//   • honeypot: campo oculto que só um bot preenche — vindo preenchido,
//     responde 200 e descarta em silêncio (não dá sinal de "isto é filtrado"
//     para quem estiver testando o formulário);
//   • erro nunca vaza detalhe interno — mensagem genérica, log só no servidor.
//
// A gravação em si passa por operador/leads.js::criar(), que roda dentro de
// comOperador() — é o único caminho que atravessa a policy USING(false) da
// tabela (ver migração 025).
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const leads = require('../operador/leads');

const router = express.Router();

// Mesmo tratamento de X-Forwarded-For com porta usado em auth/routes.js e
// operador/routes.js — o app já fixa `trust proxy` em 2 hops (Cloudflare +
// Traefik).
function chavePorIp(req) {
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
  const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return m ? m[1] : ip;
}

// Formulário de contato: baixo volume esperado por visitante. 5 em 15 min é
// folgado para uma pessoa legítima e curto o bastante para não virar vetor de
// spam na caixa de leads.
const leadsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chavePorIp,
  validate: { trustProxy: false },
  message: { error: 'Muitas tentativas. Espere alguns minutos e tente de novo.' },
});

/** 400 sem ecoar o valor enviado. */
function checarValidacao(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    error: 'Dados inválidos.',
    errors: errors.array().map((e) => ({ campo: e.path, msg: e.msg })),
  });
  return true;
}

router.post(
  '/',
  leadsLimiter,
  // Honeypot ANTES da validação dos campos reais: um bot que preenche tudo
  // errado (ou nada) ainda cai aqui primeiro, e sai com 200 sem gravar nada
  // — nenhuma resposta diferente entre "descartado por honeypot" e "aceito"
  // ajudaria quem estiver testando o filtro a contorná-lo.
  (req, res, next) => {
    if (String(req.body?.site || '').trim() !== '') {
      return res.status(200).json({ ok: true });
    }
    next();
  },
  body('nome').isString().trim().isLength({ min: 1, max: 160 }),
  body('empresa').isString().trim().isLength({ min: 1, max: 160 }),
  body('email').isString().trim().isLength({ min: 3, max: 160 }).isEmail(),
  body('tamanhoEquipe').optional({ nullable: true }).isString().trim().isLength({ max: 60 }),
  // SEM isLength aqui de propósito (achado [P1] da review do PR #42): `origem`
  // é metadado de rastreamento (querystring utm + gclid/fbclid facilmente
  // passam de 200 chars) — `operador/leads.js::limitar()` já corta o que não
  // cabe na coluna. Um lead de campanha paga não pode ser REJEITADO por causa
  // de um campo auxiliar; o fallback de mailto do front só entra em ação em
  // falha de REDE, não em 400, então rejeitar aqui perdia o contato de vez.
  body('origem').optional({ nullable: true }).isString().trim(),
  async (req, res) => {
    if (checarValidacao(req, res)) return;
    try {
      await leads.criar({
        nome: req.body.nome,
        empresa: req.body.empresa,
        email: req.body.email.toLowerCase(),
        tamanhoEquipe: req.body.tamanhoEquipe,
        origem: req.body.origem,
        userAgent: req.get('user-agent'),
        ip: chavePorIp(req),
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      // Nunca vaza detalhe interno (nome de coluna, mensagem do driver) para
      // quem preencheu um formulário público — só o servidor vê o motivo real.
      console.error('[leads] falha ao registrar lead:', err.message);
      res.status(500).json({ error: 'Não foi possível registrar sua solicitação agora. Tente novamente em instantes.' });
    }
  }
);

module.exports = router;
