// server/ia/stt.js — transcrição de áudio (STT) do bot de IA.
//
// SEMPRE OpenAI, independente do provedor de CHAT do tenant: a Anthropic não
// tem API de áudio. Ordem da credencial:
//   1. a do próprio tenant, se o provedor dele já for 'openai';
//   2. a credencial OpenAI GLOBAL do operador (`provedor_credencial`), lida
//      INDEPENDENTE de `ativo` — a credencial ativa costuma ser a Anthropic, e
//      ainda assim o operador pode ter uma chave OpenAI cadastrada.
// Sem nenhuma das duas ⇒ null, e o runtime responde pedindo texto. NUNCA
// silêncio.
//
// MODELO: whisper-1. É o que aceita `response_format=verbose_json` e devolve
// `duration` — de onde sai a quantidade do evento de consumo `ia_audio_seg`.
// `gpt-4o-mini-transcribe` não devolve duração, e sem duração não há medição.
//
// ⚠️ ONDE RODA: na FASE 2 do ia/runtime.js, com ZERO conexão do pool aberta.
// É chamada de rede (mais a leitura do storage) e pode levar segundos —
// segurar uma conexão de tenant durante isso esgota o pool sob concorrência,
// exatamente o defeito que as 3 fases do runtime existem para evitar. Além
// disso, `credencialOpenAI` abre uma transação de OPERADOR por baixo dos panos
// (mesmo motivo do ia/iaConfigStore.js).
'use strict';

const operadorDb = require('../operador/db');
const credencialOperador = require('./credencialOperador');
const { storage } = require('../storage');

const MODELO = 'whisper-1';
const BASE_PADRAO = 'https://api.openai.com/v1';
const TIMEOUT_MS = 60_000;

/** Credencial OpenAI para transcrever, ou null se não houver nenhuma. */
async function credencialOpenAI(configDoTenant) {
  if (configDoTenant && configDoTenant.provider === 'openai' && configDoTenant.apiKey) {
    return { apiKey: configDoTenant.apiKey, baseUrl: configDoTenant.baseUrl || BASE_PADRAO };
  }
  return operadorDb.comOperador(async (conn) => {
    let r;
    try {
      r = await conn.execute(
        `SELECT base_url, api_key_criptografada FROM provedor_credencial WHERE provider = 'openai'`);
    } catch (err) {
      if (err.code === '42P01') return null; // migração 015 ainda não aplicada
      throw err;
    }
    if (!r.rows.length) return null;
    try {
      return {
        apiKey: credencialOperador.decifrar(r.rows[0].API_KEY_CRIPTOGRAFADA),
        baseUrl: r.rows[0].BASE_URL || BASE_PADRAO,
      };
    } catch (e) {
      console.error('[ia] credencial OpenAI do operador não decifrável — reconfigure em /api/operador/ia-credencial:', e.message);
      return null;
    }
  });
}

/** Timeout próprio: um provedor pendurado não pode segurar o turno para sempre. */
async function fetchComTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  catch (e) { if (e && e.name === 'AbortError') throw new Error(`STT sem resposta em ${TIMEOUT_MS}ms (timeout)`); throw e; }
  finally { clearTimeout(t); }
}

/** Transcreve um buffer de áudio. LANÇA em falha de rede/HTTP. */
async function transcrever({ apiKey, baseUrl, buffer, mime, nomeArquivo }) {
  const base = String(baseUrl || BASE_PADRAO).replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), nomeArquivo || 'audio.ogg');
  form.append('model', MODELO);
  form.append('response_format', 'verbose_json');
  const res = await fetchComTimeout(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const corpo = await res.json().catch(() => ({}));
    throw new Error(`STT ${res.status}: ${JSON.stringify(corpo.error || {})}`);
  }
  const json = await res.json();
  return { texto: String(json.text || '').trim(), segundos: Number(json.duration) || 0 };
}

/**
 * Caminho completo usado pelo runtime: resolve a credencial, lê os bytes do
 * storage e transcreve. NUNCA lança — qualquer falha vira { ok:false } e o
 * runtime responde pedindo texto. Transcrever não pode derrubar o atendimento
 * (mesma regra de ouro do consumo/registrar.js).
 * @returns {Promise<{ok:true,texto:string,segundos:number}|{ok:false,motivo:string}>}
 */
async function transcreverEntrada(configDoTenant, entrada) {
  try {
    const cred = await module.exports.credencialOpenAI(configDoTenant);
    if (!cred) {
      console.warn('[ia] sem credencial OpenAI para STT — a IA vai pedir texto');
      return { ok: false, motivo: 'sem_credencial' };
    }
    const buffer = await storage.ler(entrada.midiaCaminho);
    const nome = String(entrada.midiaCaminho).split('/').pop() || 'audio.ogg';
    const r = await module.exports.transcrever({
      apiKey: cred.apiKey, baseUrl: cred.baseUrl, buffer, mime: entrada.mime, nomeArquivo: nome,
    });
    // Trim defensivo: transcrever() já apara, mas a garantia de "não existe
    // turno de usuário vazio" mora AQUI — um turno `user` sem conteúdo remonta
    // como content:[] e o provedor rejeita a conversa inteira na mensagem
    // seguinte (mesmo defeito que o turno assistant vazio já causava).
    const texto = String(r.texto || '').trim();
    if (!texto) return { ok: false, motivo: 'vazio' };
    return { ok: true, texto, segundos: r.segundos };
  } catch (err) {
    console.error('[ia] STT falhou (a IA vai pedir texto):', (err && err.message) || err);
    return { ok: false, motivo: 'falha' };
  }
}

module.exports = { MODELO, credencialOpenAI, transcrever, transcreverEntrada };
