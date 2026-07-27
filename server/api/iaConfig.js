// api/iaConfig.js — config do provedor de IA (1 linha por tenant). GET sem a
// chave; PUT ADMIN. FIL-63: escopado por req.tenantId via db.comTenant() — o
// middleware de auth que popula req.tenantId ainda não existe (login próprio
// é o FIL-59); até lá comTenant() recusa a requisição (tenantId inválido) em
// vez de vazar dado sem contexto de tenant.
'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const { criptografar } = require('../ia/crypto');

const router = express.Router();
const PROVEDORES = ['anthropic', 'openai', 'openrouter', 'ollama', 'vllm', 'groq'];

router.get('/', async (req, res, next) => {
  try {
    const row = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT PROVIDER, MODELO, BASE_URL, ATIVO, ATUALIZADO_EM FROM ia_config
          WHERE tenant_id = :tenantId AND ID = 1`,
        { tenantId: req.tenantId });
      return (r.rows && r.rows[0]) || null;
    });
    if (!row) return res.json({ provider: null, modelo: null, baseUrl: null, ativo: false });
    res.json({ provider: row.PROVIDER, modelo: row.MODELO, baseUrl: row.BASE_URL, ativo: row.ATIVO === 'S', atualizadoEm: row.ATUALIZADO_EM });
  } catch (err) {
    if (err.code === '42P01') return res.json({ provider: null, modelo: null, baseUrl: null, ativo: false });
    next(err);
  }
});

router.put('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const { provider, modelo, baseUrl, apiKey } = req.body || {};
  if (!PROVEDORES.includes(provider)) return res.status(400).json({ error: 'Provider inválido' });
  const modeloTrim = String(modelo || '').trim();
  if (!modeloTrim) return res.status(400).json({ error: 'Modelo obrigatório' });
  if (/^https?:\/\//i.test(modeloTrim)) {
    return res.status(400).json({ error: 'Modelo não pode ser uma URL — use só o ID (ex.: openai/gpt-4o-mini). A URL vai no campo Base URL.' });
  }

  // Base URL: obrigatória e VÁLIDA para provedores OpenAI-compatíveis. Normaliza
  // (tira barra final e um "/chat/completions" colado por engano).
  let baseNorm = null;
  if (provider !== 'anthropic') {
    const raw = String(baseUrl || '').trim();
    if (!raw) return res.status(400).json({ error: 'Base URL obrigatória para provedores compatíveis' });
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ error: 'Base URL inválida — use algo como https://openrouter.ai/api/v1' }); }
    if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'Base URL deve ser http(s)://…' });
    baseNorm = raw.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  }

  const temChaveNova = apiKey && String(apiKey).trim();

  try {
    await db.comTenant(req.tenantId, async (conn) => {
      // Chave OPCIONAL na edição: se não veio chave nova, mantém a já cifrada
      // (permite corrigir modelo/URL sem recolar a chave). Na 1ª config, é obrigatória.
      let cifrada;
      if (temChaveNova) {
        cifrada = criptografar(String(apiKey), req.tenantId);
      } else {
        const ex = await conn.execute(
          `SELECT API_KEY_CRIPTOGRAFADA FROM ia_config WHERE tenant_id = :tenantId AND ID = 1`,
          { tenantId: req.tenantId });
        cifrada = ex.rows && ex.rows.length ? ex.rows[0].API_KEY_CRIPTOGRAFADA : null;
        if (!cifrada) throw Object.assign(new Error('API key obrigatória na primeira configuração'), { status: 400 });
      }
      await conn.execute(
        `INSERT INTO ia_config (tenant_id, ID, PROVIDER, MODELO, BASE_URL, API_KEY_CRIPTOGRAFADA, ATIVO, ATUALIZADO_POR, ATUALIZADO_EM)
         VALUES (:tenantId, 1, :p, :m, :b, :k, 'S', :atd, now())
         ON CONFLICT (tenant_id, ID) DO UPDATE SET
           PROVIDER = EXCLUDED.PROVIDER, MODELO = EXCLUDED.MODELO, BASE_URL = EXCLUDED.BASE_URL,
           API_KEY_CRIPTOGRAFADA = EXCLUDED.API_KEY_CRIPTOGRAFADA, ATIVO = 'S',
           ATUALIZADO_POR = EXCLUDED.ATUALIZADO_POR, ATUALIZADO_EM = now()`,
        { tenantId: req.tenantId, p: provider, m: modeloTrim, b: baseNorm, k: cifrada, atd: req.perfil && req.perfil.atendenteId });
      await conn.execute(
        `INSERT INTO auditoria (tenant_id, ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
         VALUES (:tenantId, :atd, :mat, 'ia_config_alterada', 'ia_config', 1, :det)`,
        { tenantId: req.tenantId, atd: req.perfil && req.perfil.atendenteId, mat: req.user && req.user.matricula,
          det: JSON.stringify({ provider, modelo: modeloTrim, baseUrl: baseNorm,
            api_key_sha256: temChaveNova ? crypto.createHash('sha256').update(String(apiKey)).digest('hex') : 'mantida' }) });
    });
    require('../ia/iaConfigStore').invalidar(req.tenantId);
    res.json({ ok: true });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
