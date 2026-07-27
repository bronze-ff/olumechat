// graph/client.js — Wrapper mínimo da Graph API (Cloud API).
// Usa fetch global (Node 18+). Versão da Graph configurável via .env.
const { loadConfig } = require('../config');
const { mensagemAmigavel } = require('./errors');
const { resolver } = require('../meta/connection');

const cfg = loadConfig({ requireDb: false });
const BASE = `https://graph.facebook.com/${cfg.graphVersion}`;

// Timeout em TODA chamada à Meta. Sem isto, uma chamada pendurada (rede de saída
// instável) prende a conexão Oracle de quem chamou (dispatcher de campanha,
// webhook no download de mídia) e ajuda a esgotar o pool → NJS-040.
const META_TIMEOUT_MS = Number(process.env.GRAPH_TIMEOUT_MS) || 30_000;
async function fetchMeta(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`Meta sem resposta em ${META_TIMEOUT_MS}ms (timeout)`);
    throw e;
  } finally { clearTimeout(t); }
}

/**
 * POST para o endpoint /messages de um número específico (multi-número).
 * @param {object} body           Corpo da mensagem (text/template/...).
 * @param {string} [phoneNumberId] Número de origem; em produção é obrigatório e deve estar vinculado ao tenant.
 * @returns {Promise<object>} Resposta JSON da Meta (contém messages[].id = wamid).
 */
async function credenciais(phoneNumberId, tenantId) {
  const id = phoneNumberId || (cfg.devMetaFallback ? cfg.phoneNumberId : null);
  // Desenvolvimento/testes sem banco preservam o caminho legado; em produção
  // este ramo é impossível e o token sempre vem da conexão do tenant.
  if (cfg.devMetaFallback && cfg.waToken && id) {
    return { phoneNumberId: id, accessToken: cfg.waToken, tenantId: null };
  }
  const c = await resolver(id, tenantId);
  if (c) return c;
  throw new Error('Número WhatsApp não está conectado a uma conta Meta deste tenant');
}

async function sendMessage(body, phoneNumberId, tenantId) {
  const c = await credenciais(phoneNumberId, tenantId);
  const from = c.phoneNumberId;
  const url = `${BASE}/${from}/messages`;
  const res = await fetchMeta(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    // Log com o detalhe cru (diagnóstico); a mensagem do erro já é a amigável.
    console.error(
      `[graph] erro ${res.status}: code=${e.code} subcode=${e.error_subcode || '-'} ` +
      `msg="${e.message || ''}" details=${e.error_data ? JSON.stringify(e.error_data) : '-'}`
    );
    const err = new Error(mensagemAmigavel(e.code, e.message));
    err.isGraphError = true;
    err.graphCode = e.code;
    err.graphSubcode = e.error_subcode;
    err.graphMessage = e.message;
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}

// Hosts da Meta onde é seguro mandar o Bearer token (anti-SSRF).
const HOSTS_META = /(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com|whatsapp\.net)$/i;

/** GET autenticado na Graph API (usado p/ metadados de mídia). */
async function graphGet(pathOrUrl, phoneNumberId, tenantId) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}/${pathOrUrl}`;
  // SSRF: só seguimos (e mandamos o token) para hosts https da Meta. A URL de
  // download de mídia vem da resposta da Graph, mas validamos mesmo assim.
  let host;
  try { const u = new URL(url); if (u.protocol !== 'https:') throw 0; host = u.hostname; }
  catch { throw new Error('URL inválida para a Graph API'); }
  if (!HOSTS_META.test(host)) throw new Error(`Host não permitido: ${host}`);
  const c = await credenciais(phoneNumberId, tenantId);
  const res = await fetchMeta(url, { headers: { Authorization: `Bearer ${c.accessToken}` } });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`Graph GET ${res.status}: ${JSON.stringify(json.error || {})}`);
  }
  return res;
}

/** POST genérico autenticado (ex.: /{phone_number_id}/register). Erro da Meta
    volta com a mensagem real (e error_user_msg, quando houver) p/ diagnóstico. */
async function graphPost(pathOrUrl, body, phoneNumberId, tenantId) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}/${pathOrUrl}`;
  const c = await credenciais(phoneNumberId || pathOrUrl.split('/')[0], tenantId);
  const res = await fetchMeta(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    const detalhe = e.error_user_msg || (e.error_data && e.error_data.details) || '';
    const err = new Error((e.message || `Graph POST ${res.status}`) + (detalhe ? ` — ${detalhe}` : ''));
    err.isGraphError = true; err.graphCode = e.code; err.httpStatus = res.status;
    throw err;
  }
  return json;
}

module.exports = { sendMessage, graphGet, graphPost, cfg, BASE, credenciais };
