'use strict';

const express = require('express');
const db = require('../db/pool');
const { guardar } = require('../meta/connection');
const appCliente = require('../meta/appCliente');
const { exigirPapel } = require('../auth/rbac');

const router = express.Router();

/**
 * O cliente administra a operação, mas não credenciais/IDs da Meta. Trocar o
 * code do Embedded Signup grava o access_token e faz UPSERT no `numero` do
 * tenant — sobrescreve o canal oficial já conectado. Mesmo padrão do
 * api/numeros.js::exigirSuporteOperador: é tarefa técnica do operador dentro
 * da sessão de suporte auditada, não de um ATENDENTE/SUPERVISOR do cliente.
 */
function exigirSuporteOperador(req, res, next) {
  if (req.user && req.user.suporte === true) return next();
  return res.status(403).json({
    error: 'A conexão do canal com a Meta é realizada pelo operador em um acesso de suporte.',
  });
}

// Troca o código de curta duração emitido pelo Embedded Signup. O app secret
// nunca sai do servidor e o token recebido nunca é devolvido ao navegador.
async function trocarCodigo(code) {
  const appId = process.env.META_APP_ID;
  if (!appId || !process.env.META_APP_SECRET) throw new Error('Embedded Signup não configurado');
  const u = new URL('https://graph.facebook.com/oauth/access_token');
  u.searchParams.set('client_id', appId);
  u.searchParams.set('client_secret', process.env.META_APP_SECRET);
  u.searchParams.set('code', String(code));
  const r = await fetch(u, { method: 'GET' });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) throw new Error(json.error && json.error.message || 'A Meta recusou o código do Embedded Signup');
  return json;
}

router.post('/signup/exchange', exigirSuporteOperador, async (req, res, next) => {
  const { code, wabaId, phoneNumberId, displayPhone, nomeExibicao } = req.body || {};
  if (!code || !phoneNumberId) return res.status(400).json({ error: 'code e phoneNumberId são obrigatórios' });
  try {
    const meta = await trocarCodigo(code);
    await db.comTenant(req.tenantId, async (conn) => {
      await guardar({ tenantId: req.tenantId, accessToken: meta.access_token, wabaId, conn });
      await conn.execute(
        `INSERT INTO numero (phone_number_id, display_phone, nome_exibicao, waba_id)
         VALUES (:phone, :displayPhone, :nome, :waba)
         ON CONFLICT (phone_number_id) DO UPDATE SET display_phone = COALESCE(EXCLUDED.display_phone, numero.display_phone),
           nome_exibicao = COALESCE(EXCLUDED.nome_exibicao, numero.nome_exibicao), waba_id = COALESCE(EXCLUDED.waba_id, numero.waba_id)`,
        { phone: String(phoneNumberId), displayPhone: displayPhone || null, nome: nomeExibicao || null, waba: wabaId || null });
    });
    res.status(201).json({ ok: true, status: 'conectada', wabaId: wabaId || null, phoneNumberId: String(phoneNumberId) });
  } catch (err) { next(err); }
});

// waba_id/qualidade do número são info operacional do canal, não dado de
// atendimento — mesmo gate de leitura usado em numeros.js.
router.get('/status', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT n.phone_number_id, n.display_phone, n.quality_rating, n.messaging_tier,
                m.waba_id, m.status, m.ultimo_erro, m.atualizado_em
           FROM meta_conexao m LEFT JOIN numero n ON n.tenant_id = m.tenant_id
          WHERE m.tenant_id = :tenantId`, { tenantId: req.tenantId });
      return r.rows;
    });
    res.json(rows.map((r) => ({ phoneNumberId: r.PHONE_NUMBER_ID, displayPhone: r.DISPLAY_PHONE,
      qualityRating: r.QUALITY_RATING, messagingTier: r.MESSAGING_TIER, wabaId: r.WABA_ID,
      status: r.STATUS, pending: r.ULTIMO_ERRO || null, atualizadoEm: r.ATUALIZADO_EM })));
  } catch (err) { next(err); }
});

// ── App da Meta DO CLIENTE (FIL-97) ────────────────────────────────────────
// Enquanto a Olume não tem CNPJ (e portanto nenhum app verificado próprio),
// cada cliente usa o app dele. Isto é trabalho técnico de implantação — App ID,
// App Secret e token permanente saem do painel da Meta do cliente e são colados
// aqui pelo operador dentro da sessão de suporte auditada. Mesmo gate do
// /signup/exchange, e toda mutação de suporte já cai na trilha que o PRÓPRIO
// cliente lê (auth/middleware.js); a auditoria explícita abaixo é o registro
// com nome e detalhe do que mudou — nunca com os valores.

/**
 * Base pública da API, para montar a URL que o operador cola no app do cliente.
 * `WEBHOOK_BASE_URL` é opcional: sem ela, deduzimos do próprio request (o
 * Express já resolve protocolo/host pelos proxies confiáveis do `trust proxy`).
 * Defina-a nos ambientes hospedados — o valor deduzido depende do header Host,
 * e a URL exibida aqui vai ser colada numa configuração da Meta, onde um valor
 * errado só aparece como "o webhook nunca chega".
 */
function baseDoWebhook(req) {
  const configurada = String(process.env.WEBHOOK_BASE_URL || '').trim();
  if (configurada) return configurada.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function comUrl(req, dados) {
  return {
    ...dados,
    webhookUrl: dados.identificador ? baseDoWebhook(req) + appCliente.caminhoWebhook(dados.identificador) : null,
  };
}

router.get('/app', exigirSuporteOperador, async (req, res, next) => {
  try {
    const dados = await db.comTenant(req.tenantId, (conn) => appCliente.carregar(conn, req.tenantId));
    res.json(comUrl(req, dados));
  } catch (err) { next(err); }
});

router.put('/app', exigirSuporteOperador, async (req, res, next) => {
  const { appId, appSecret, accessToken, wabaId } = req.body || {};
  const temAlgo = [appId, appSecret, accessToken, wabaId].some((v) => String(v || '').trim());
  if (!temAlgo) return res.status(400).json({ error: 'Informe ao menos um campo para gravar.' });
  try {
    const dados = await db.comTenant(req.tenantId, async (conn) => {
      // O token permanente vem primeiro: é ele que cria a linha de meta_conexao
      // (access_token_criptografado é NOT NULL desde a migração 008). O WABA ID
      // NÃO vai aqui: quem grava é o `salvar` abaixo, para valer também quando o
      // operador só corrige o WABA e não tem o token em mãos (review do PR #43).
      if (String(accessToken || '').trim()) {
        await guardar({ tenantId: req.tenantId, accessToken: String(accessToken).trim(), conn });
      }
      const salvo = await appCliente.salvar(conn, req.tenantId, { appId, appSecret, wabaId });
      await conn.execute(
        `INSERT INTO auditoria (acao, entidade, entidade_id, detalhe, ip)
         VALUES ('meta_app_cliente', 'meta_conexao', :id, :det, :ip)`,
        {
          id: req.tenantId,
          // Só O QUE mudou, nunca o valor: esta trilha é lida no painel do cliente.
          det: JSON.stringify({
            appId: salvo.appId || null,
            wabaId: salvo.wabaId || null,
            appSecret: salvo.appSecretAtualizado,
            accessToken: Boolean(String(accessToken || '').trim()),
            operador: (req.user && req.user.email) || null,
          }),
          ip: req.ip || null,
        }
      );
      return appCliente.carregar(conn, req.tenantId);
    });
    res.json(comUrl(req, dados));
  } catch (err) {
    if (err && err.status === 409) return res.status(409).json({ error: err.message });
    next(err);
  }
});

module.exports = { router, trocarCodigo, baseDoWebhook };
