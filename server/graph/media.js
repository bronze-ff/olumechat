// graph/media.js — Recebimento e envio de arquivos (mídia).
//
// RECEBER: o webhook traz apenas o `media_id`. Buscamos a URL temporária na
// Graph API e baixamos o binário para o diretório local (servidor de
// arquivos Windows — cfg.mediaDir). Metadados vão para MC_ZAP_MIDIA.
//
// ENVIAR: upload do arquivo (gera media_id) ou envio por link hospedado.
const fs = require('fs');
const path = require('path');
const { graphGet, sendMessage, BASE, credenciais } = require('./client');
const { storage, storageKey } = require('../storage');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

function extFromMime(mime) {
  if (!mime) return '';
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const base = mime.split(';')[0];
  return EXT_BY_MIME[base] || '';
}

/**
 * Baixa uma mídia recebida para o disco.
 * @param {object} mediaObj  Objeto da mídia no webhook (image/document/audio/...).
 *   Espera { id, mime_type, sha256, filename?, caption? }.
 * @returns {Promise<object>} Metadados para gravar em MC_ZAP_MIDIA.
 */
async function downloadMedia(mediaObj, { tenantId, conversaId, phoneNumberId } = {}) {
  const mediaId = mediaObj.id;

  // 1) Resolve a URL temporária do arquivo.
  const metaRes = await graphGet(mediaId, phoneNumberId, tenantId);
  const meta = await metaRes.json();

  // 2) Baixa o binário (a URL exige o mesmo Bearer token).
  const fileRes = await graphGet(meta.url, phoneNumberId, tenantId);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  // 3) Define a chave tenant-prefixed e grava no storage configurado.
  // SEGURANÇA: o nome do arquivo NUNCA é derivado do filename do remetente
  // (controlado por terceiro → path traversal). O caminho usa só o mediaId
  // (validado pela Graph) + a extensão do MIME. O nome original fica só para
  // EXIBIÇÃO (sanitizado com basename), gravado na coluna NOME_ARQUIVO.
  const mime = meta.mime_type || mediaObj.mime_type;
  const original = mediaObj.filename ? path.basename(String(mediaObj.filename)) : null;
  const ext = extFromMime(mime) || (original ? path.extname(original) : '') || '';
  const fileName = `${String(mediaId).replace(/[^\w.-]/g, '')}${ext}`;
  const caminho = storageKey(tenantId, conversaId, fileName);
  await storage.salvar(buf, caminho, mime);

  return {
    mediaId,
    mime,
    sha256: meta.sha256 || mediaObj.sha256,
    size: meta.file_size || buf.length,
    filename: original || fileName,
    caminho,
    caption: mediaObj.caption || null,
  };
}

/**
 * Faz upload de um arquivo local para a Meta e retorna o media_id.
 * @param {string} filePath        Caminho do arquivo.
 * @param {string} mime            MIME type.
 * @param {string} [phoneNumberId] Número de origem; default = .env.
 */
async function uploadMedia(filePath, mime, phoneNumberId, tenantId) {
  const c = await credenciais(phoneNumberId, tenantId);
  const from = c.phoneNumberId;
  const data = Buffer.isBuffer(filePath) ? filePath : fs.readFileSync(filePath);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([data], { type: mime }), Buffer.isBuffer(filePath) ? 'arquivo' : path.basename(filePath));

  const res = await fetch(`${BASE}/${from}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.accessToken}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Upload mídia ${res.status}: ${JSON.stringify(json.error || {})}`);
  return json.id; // media_id
}

/** Envia documento (PDF de boleto, etc.) por media_id OU por link. */
async function sendDocument(to, { id, link, filename, caption }, phoneNumberId, tenantId) {
  const doc = {};
  if (id) doc.id = id; else if (link) doc.link = link;
  if (filename) doc.filename = filename;
  if (caption) doc.caption = caption;
  return sendMessage({
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'document', document: doc,
  }, phoneNumberId, tenantId);
}

/** Envia imagem por media_id OU por link. */
async function sendImage(to, { id, link, caption }, phoneNumberId, tenantId) {
  const img = {};
  if (id) img.id = id; else if (link) img.link = link;
  if (caption) img.caption = caption;
  return sendMessage({
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'image', image: img,
  }, phoneNumberId, tenantId);
}

/** Envia áudio por media_id. */
async function sendAudio(to, { id }, phoneNumberId, tenantId) {
  return sendMessage({
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'audio', audio: { id },
  }, phoneNumberId, tenantId);
}

/** Envia vídeo por media_id (legenda opcional). */
async function sendVideo(to, { id, caption }, phoneNumberId, tenantId) {
  const vid = { id };
  if (caption) vid.caption = caption;
  return sendMessage({
    messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'video', video: vid,
  }, phoneNumberId, tenantId);
}

/** Decide o tipo da Cloud API a partir do MIME (espelha o WhatsApp). */
function tipoPorMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/') && m !== 'image/webp') return 'image'; // webp = sticker, manda como doc
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

module.exports = {
  downloadMedia, uploadMedia, sendDocument, sendImage, sendAudio, sendVideo,
  tipoPorMime, extFromMime,
};
