'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const DEFAULT_EXPIRY = 300;

function storageKey(tenantId, conversaId, fileName) {
  const t = Number(tenantId); const c = Number(conversaId);
  if (!Number.isSafeInteger(t) || t <= 0 || !Number.isSafeInteger(c) || c <= 0) throw new Error('Tenant/conversa inválidos');
  const safe = path.basename(String(fileName)).replace(/[^\w.-]/g, '_');
  if (!safe) throw new Error('Nome de arquivo inválido');
  return `${t}/${c}/${safe}`;
}

function secret() {
  return process.env.STORAGE_SIGNING_SECRET || process.env.META_APP_SECRET || 'dev-storage-secret';
}

function tokenFor(key, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ key, exp: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token, key, now = Date.now()) {
  try {
    const [payload, sig] = String(token).split('.');
    const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
    if (!payload || !sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.key === key && Number(data.exp) > now ? data : false;
  } catch { return false; }
}

class LocalStorage {
  constructor({ dir = process.env.MEDIA_DIR || path.join(process.cwd(), 'media') } = {}) { this.dir = path.resolve(dir); }
  _path(key) {
    const out = path.resolve(this.dir, key);
    if (!out.startsWith(this.dir + path.sep)) throw new Error('Chave de storage inválida');
    return out;
  }
  async salvar(data, key) { const file = this._path(key); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return key; }
  async ler(key) { return fs.readFile(this._path(key)); }
  async remover(key) { await fs.rm(this._path(key), { force: true }); }
  async urlAssinada(key, { expiresIn = DEFAULT_EXPIRY, baseUrl = '/api/midia' } = {}) {
    const exp = Date.now() + Math.min(Math.max(Number(expiresIn) * 1000, 1000), 3600000);
    return `${baseUrl}?storage_token=${encodeURIComponent(tokenFor(key, exp))}`;
  }
  verificar(token, key) { return verifyToken(token, key); }
}

class S3Storage {
  constructor({ bucket = process.env.STORAGE_BUCKET, endpoint = process.env.STORAGE_ENDPOINT } = {}) {
    if (!bucket) throw new Error('STORAGE_BUCKET não definido');
    this.bucket = bucket;
    this.client = new S3Client({ region: process.env.STORAGE_REGION || 'auto', endpoint: endpoint || undefined, forcePathStyle: Boolean(endpoint) });
  }
  async salvar(data, key, contentType) { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType })); return key; }
  async ler(key) { const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); return Buffer.from(await out.Body.transformToByteArray()); }
  async remover(key) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  async urlAssinada(key, { expiresIn = DEFAULT_EXPIRY } = {}) { return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: Math.min(Math.max(Number(expiresIn), 1), 3600) }); }
}

function createStorage() { return (process.env.STORAGE_DRIVER || 'local').toLowerCase() === 's3' ? new S3Storage() : new LocalStorage(); }
const storage = createStorage();

module.exports = { storage, LocalStorage, S3Storage, storageKey, verifyToken, DEFAULT_EXPIRY };
