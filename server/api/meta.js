'use strict';

const express = require('express');
const db = require('../db/pool');
const { guardar } = require('../meta/connection');

const router = express.Router();

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

router.post('/signup/exchange', async (req, res, next) => {
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

router.get('/status', async (req, res, next) => {
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

module.exports = { router, trocarCodigo };
