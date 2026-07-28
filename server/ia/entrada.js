// server/ia/entrada.js — o que chega para a IA, a partir de uma mensagem do
// webhook. PURA: roda no caminho quente (toda mensagem recebida) e decide sem
// tocar banco, storage nem rede.
//
// Obstáculo 7 do ticket: `webhook/processEvent.js` só empurrava
// `msg.type === 'text'` para a IA. O cliente mandava um áudio e recebia
// SILÊNCIO — o pior comportamento possível num canal de atendimento.
//
// CINCO SAÍDAS:
//   'texto'          — inclusive botão/lista/localização/pedido: o webhook já
//                      converteu para texto amigável (utils/descreverMensagem),
//                      então para a IA é só mais uma fala do cliente. Custo zero.
//   'audio'          — o webhook já baixou; o STT roda na FASE 2 do runtime.
//   'imagem'         — o provedor de chat enxerga (Claude e OpenAI aceitam).
//   'nao_suportado'  — vídeo, documento, sticker, contato, áudio longo demais,
//                      imagem em formato/tamanho fora do aceito, e mídia cujo
//                      download FALHOU. A IA responde pedindo texto/foto —
//                      educada, uma vez por tipo por conversa, nunca silêncio.
//   'ignorar'        — reação, evento de sistema, tipo desconhecido, texto
//                      vazio: não acordam a IA.
'use strict';

// Interseção do que Anthropic e OpenAI aceitam como imagem.
const MIMES_IMAGEM = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES_IMAGEM = 5 * 1024 * 1024;

// Teto DEFENSIVO de áudio. A duração real só é conhecida DEPOIS de transcrever
// (ia/stt.js lê `duration` do verbose_json), então o corte barato é por bytes:
// ~350 KB é bem mais que os 2 minutos de voice note OPUS (16 kbps ≈ 2 KB/s) que
// a spec definiu como limite. Voice note de atendimento é curta; 2 min de
// Whisper por mensagem é custo e latência que ninguém pediu.
const MAX_BYTES_AUDIO = 350 * 1024;

// Tipos que o webhook já converteu para texto amigável em `conteudo`.
const TIPOS_TEXTO = new Set(['text', 'button', 'interactive', 'location', 'order', 'request_welcome']);
// Tipos que NÃO acordam a IA.
const TIPOS_IGNORADOS = new Set(['reaction', 'system', 'unsupported']);
// Mídia que a IA ainda não compreende (fora do escopo desta fatia: OCR, vídeo).
const TIPOS_NAO_COMPREENDIDOS = new Set(['video', 'document', 'sticker', 'contacts']);

function naoSuportado(tipoOriginal) {
  return { tipo: 'nao_suportado', texto: '', midiaCaminho: null, mime: null, tamanho: null, tipoOriginal };
}

function ignorar(tipoOriginal) {
  return { tipo: 'ignorar', texto: '', midiaCaminho: null, mime: null, tamanho: null, tipoOriginal };
}

/**
 * @param {object} msg           mensagem crua do webhook (precisa de `msg.type`)
 * @param {string|null} conteudo o texto que o webhook já gravou em `mensagem.conteudo`
 * @param {object|null} media    metadados do download (null = falhou ou não é mídia)
 * @returns {{tipo: string, texto: string, midiaCaminho: string|null, mime: string|null, tamanho: number|null, tipoOriginal: string|null}}
 */
function classificar(msg, conteudo, media) {
  const tipo = (msg && msg.type) || '';
  const texto = String(conteudo || '').trim();

  if (TIPOS_IGNORADOS.has(tipo)) return ignorar(tipo);

  if (TIPOS_TEXTO.has(tipo)) {
    if (!texto) return ignorar(tipo);
    return { tipo: 'texto', texto, midiaCaminho: null, mime: null, tamanho: null, tipoOriginal: tipo };
  }

  if (tipo === 'audio') {
    // Download falhou (safeDownload devolve null): a mensagem existe, a mídia
    // não. Fingir que temos áudio faria o runtime ler um caminho inexistente.
    if (!media || !media.caminho) return naoSuportado('audio');
    if (Number(media.size) > MAX_BYTES_AUDIO) return naoSuportado('audio_longo');
    return { tipo: 'audio', texto, midiaCaminho: media.caminho, mime: media.mime || null,
      tamanho: Number(media.size) || null, tipoOriginal: 'audio' };
  }

  if (tipo === 'image') {
    if (!media || !media.caminho) return naoSuportado('image');
    const mime = String(media.mime || '').split(';')[0].toLowerCase();
    if (!MIMES_IMAGEM.has(mime)) return naoSuportado('image');
    if (Number(media.size) > MAX_BYTES_IMAGEM) return naoSuportado('image');
    return { tipo: 'imagem', texto, midiaCaminho: media.caminho, mime,
      tamanho: Number(media.size) || null, tipoOriginal: 'image' };
  }

  if (TIPOS_NAO_COMPREENDIDOS.has(tipo)) return naoSuportado(tipo);
  return ignorar(tipo);
}

module.exports = { classificar, MIMES_IMAGEM, MAX_BYTES_IMAGEM, MAX_BYTES_AUDIO };
