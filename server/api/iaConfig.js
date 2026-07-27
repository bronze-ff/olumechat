// api/iaConfig.js — config do provedor de IA (1 linha). GET sem a chave; PUT ADMIN.
'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const { criptografar } = require('../ia/crypto');

const router = express.Router();
const PROVEDORES = ['anthropic', 'openai', 'openrouter', 'ollama', 'vllm', 'groq'];

router.get('/', async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT PROVIDER, MODELO, BASE_URL, ATIVO, ATUALIZADO_EM FROM MC_ZAP_IA_CONFIG WHERE ID = 1`);
    if (!r.rows || !r.rows.length) return res.json({ provider: null, modelo: null, baseUrl: null, ativo: false });
    const row = r.rows[0];
    res.json({ provider: row.PROVIDER, modelo: row.MODELO, baseUrl: row.BASE_URL, ativo: row.ATIVO === 'S', atualizadoEm: row.ATUALIZADO_EM });
  } catch (err) { if (err.errorNum === 942) return res.json({ provider: null, modelo: null, baseUrl: null, ativo: false }); next(err); } finally { if (conn) await conn.close().catch(() => {}); }
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

  let conn;
  try {
    conn = await db.getConnection();
    // Chave OPCIONAL na edição: se não veio chave nova, mantém a já cifrada
    // (permite corrigir modelo/URL sem recolar a chave). Na 1ª config, é obrigatória.
    let cifrada;
    if (temChaveNova) {
      cifrada = criptografar(String(apiKey));
    } else {
      const ex = await conn.execute(`SELECT API_KEY_CRIPTOGRAFADA FROM MC_ZAP_IA_CONFIG WHERE ID = 1`);
      cifrada = ex.rows && ex.rows.length ? ex.rows[0].API_KEY_CRIPTOGRAFADA : null;
      if (!cifrada) return res.status(400).json({ error: 'API key obrigatória na primeira configuração' });
    }
    await conn.execute(
      `MERGE INTO MC_ZAP_IA_CONFIG c USING (SELECT 1 AS ID FROM DUAL) n ON (c.ID = n.ID)
        WHEN MATCHED THEN UPDATE SET c.PROVIDER=:p, c.MODELO=:m, c.BASE_URL=:b, c.API_KEY_CRIPTOGRAFADA=:k, c.ATIVO='S', c.ATUALIZADO_POR=:atd, c.ATUALIZADO_EM=SYSTIMESTAMP
        WHEN NOT MATCHED THEN INSERT (ID, PROVIDER, MODELO, BASE_URL, API_KEY_CRIPTOGRAFADA, ATIVO, ATUALIZADO_POR)
          VALUES (1, :p2, :m2, :b2, :k2, 'S', :atd2)`,
      { p: provider, m: modeloTrim, b: baseNorm, k: cifrada, atd: req.perfil && req.perfil.atendenteId,
        p2: provider, m2: modeloTrim, b2: baseNorm, k2: cifrada, atd2: req.perfil && req.perfil.atendenteId });
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:atd, :mat, 'ia_config_alterada', 'ia_config', 1, :det)`,
      { atd: req.perfil && req.perfil.atendenteId, mat: req.user && req.user.matricula,
        det: JSON.stringify({ provider, modelo: modeloTrim, baseUrl: baseNorm,
          api_key_sha256: temChaveNova ? crypto.createHash('sha256').update(String(apiKey)).digest('hex') : 'mantida' }) });
    await conn.commit();
    require('../ia/iaConfigStore').invalidar();
    res.json({ ok: true });
  } catch (err) { if (conn) await conn.rollback().catch(() => {}); next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

module.exports = router;
