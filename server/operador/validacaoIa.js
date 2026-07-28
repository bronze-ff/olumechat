// operador/validacaoIa.js — validação de provider/modelo/baseUrl,
// compartilhada entre a credencial por tenant (ia_config, legado, ver
// operador/tenants.js::salvarIaConfig) e a credencial GLOBAL do operador
// (provedor_credencial, FIL-78, ver operador/credencialIa.js::salvarCredencial).
// Módulo próprio (não dentro de tenants.js) para evitar ciclo de require:
// ia/iaConfigStore.js precisa de operador/credencialIa.js para resolver a
// credencial global, e operador/tenants.js já depende de ia/iaConfigStore.js
// (invalida o cache por tenant) — se credencialIa.js importasse de tenants.js
// o require viraria um ciclo.
'use strict';

const { ErroOperador } = require('./erroOperador');

const IA_PROVEDORES = Object.freeze(['anthropic', 'openai', 'openrouter', 'ollama', 'vllm', 'groq']);

/**
 * Provider na allowlist, modelo não pode ser uma URL colada por engano, e
 * provedores OpenAI-compatíveis (todos menos anthropic) exigem baseUrl.
 * @returns {{ provider: string, modelo: string, baseUrl: string|null }}
 */
function validarProviderModeloBaseUrl({ provider, modelo, baseUrl }) {
  if (!IA_PROVEDORES.includes(provider)) throw new ErroOperador(400, 'Provedor inválido.');
  const modeloTrim = String(modelo || '').trim();
  if (!modeloTrim) throw new ErroOperador(400, 'Modelo obrigatório.');
  if (/^https?:\/\//i.test(modeloTrim)) {
    throw new ErroOperador(400, 'Modelo não pode ser uma URL — use só o ID (ex.: gpt-4o-mini). A URL vai no campo Base URL.');
  }
  let baseNorm = null;
  if (provider !== 'anthropic') {
    const raw = String(baseUrl || '').trim();
    if (!raw) throw new ErroOperador(400, 'Base URL obrigatória para provedores compatíveis.');
    let u;
    try { u = new URL(raw); } catch { throw new ErroOperador(400, 'Base URL inválida — use algo como https://openrouter.ai/api/v1'); }
    if (!/^https?:$/.test(u.protocol)) throw new ErroOperador(400, 'Base URL deve ser http(s)://…');
    baseNorm = raw.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  }
  return { provider, modelo: modeloTrim, baseUrl: baseNorm };
}

module.exports = { IA_PROVEDORES, validarProviderModeloBaseUrl };
