// Testes do endpoint de UPLOAD de arquivo (POST /api/conversas/:id/arquivos).
// Exercita o middleware multer (2.x): allowlist de MIME (fileFilter), teto de
// tamanho (limits.fileSize) e o fluxo feliz de ponta a ponta (parse do upload →
// grava no disco → uploadMedia → send* pra Graph), com Oracle e fetch mockados.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');
const { cfg: cfgGraph } = require('../graph/client');

// Diretório temporário p/ os arquivos gravados pela rota (não polui o repo).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-zap-upload-'));
cfgGraph.mediaDir = TMP_DIR;

const TOKEN = jwt.sign({ jti: 't1', matricula: 123, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

function fakeConn({ janelaExpiraEm }) {
  const executed = [];
  return {
    executed,
    async execute(sql, binds) {
      executed.push({ sql, binds });
      // conversaNoEscopo (guard de IDOR): devolve a conversa p/ a checagem.
      if (sql.includes('SELECT ID, DEPARTAMENTO_ID, NUMERO_ID, ATENDENTE_ID')) {
        return { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: 2, ATENDENTE_ID: null }] };
      }
      if (sql.includes('FROM MC_ZAP_CONVERSA c')) {
        return {
          rows: [{
            ID: 7, CONTATO_ID: 3, NUMERO_ID: 2, JANELA_EXPIRA_EM: janelaExpiraEm,
            DEPARTAMENTO_ID: null, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '5550009999',
          }],
        };
      }
      if (sql.includes('FROM MC_ZAP_ATENDENTE')) return { rows: [{ ID: 9 }] };
      if (sql.startsWith('INSERT INTO MC_ZAP_MENSAGEM')) return { outBinds: { id: [42] } };
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
    async close() {},
  };
}

function startApp(conn) {
  db.getConnection = async () => conn; // monkey-patch (mesma instância de módulo)
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

// Monta um corpo multipart/form-data com um único campo de arquivo.
function buildMultipart({ field = 'arquivo', filename, contentType, buffer, textFields = {} }) {
  const boundary = '----mczaptestboundaryXYZ';
  const parts = [];
  for (const [k, v] of Object.entries(textFields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  }
  if (buffer) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    ));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function postMultipart(port, urlPath, multipart) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST', hostname: '127.0.0.1', port, path: urlPath,
        headers: {
          'content-type': multipart.contentType,
          'content-length': multipart.body.length,
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(multipart.body);
    req.end();
  });
}

test('upload: PDF válido → grava, sobe pra Meta, envia como documento e persiste (201)', async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts && opts.method });
    if (u.endsWith('/media')) return { ok: true, status: 200, json: async () => ({ id: 'media_ABC' }) };
    if (u.endsWith('/messages')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUTFILE' }] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const conn = fakeConn({ janelaExpiraEm: new Date(Date.now() + 60 * 60 * 1000) });
  const { server, port } = await startApp(conn);
  try {
    const mp = buildMultipart({
      filename: 'boleto.pdf', contentType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fake content'),
    });
    const r = await postMultipart(port, '/api/conversas/7/arquivos', mp);
    assert.equal(r.status, 201);
    assert.equal(r.body.tipo, 'document');
    assert.equal(r.body.nomeArquivo, 'boleto.pdf');
    assert.equal(r.body.wamid, 'wamid.OUTFILE');
    // Subiu a mídia pelo número DA CONVERSA e enviou a mensagem:
    assert.ok(calls.some((c) => c.url.includes('/5550009999/media')), 'chamou upload de mídia');
    assert.ok(calls.some((c) => c.url.includes('/5550009999/messages')), 'enviou a mensagem');
    // Persistiu a saída no histórico:
    assert.ok(conn.executed.some((e) => e.sql.startsWith('INSERT INTO MC_ZAP_MENSAGEM')));
  } finally { server.close(); }
});

test('upload: MIME não permitido (fileFilter) → 415', async () => {
  global.fetch = async () => { throw new Error('não deveria chamar a Graph'); };
  const conn = fakeConn({ janelaExpiraEm: new Date(Date.now() + 60 * 60 * 1000) });
  const { server, port } = await startApp(conn);
  try {
    const mp = buildMultipart({
      filename: 'virus.exe', contentType: 'application/x-msdownload',
      buffer: Buffer.from('MZ fake exe'),
    });
    const r = await postMultipart(port, '/api/conversas/7/arquivos', mp);
    assert.equal(r.status, 415);
    assert.equal(r.body.error, 'Tipo de arquivo não permitido.');
  } finally { server.close(); }
});

test('upload: arquivo acima de 16MB (limits.fileSize) → 415', async () => {
  global.fetch = async () => { throw new Error('não deveria chamar a Graph'); };
  const conn = fakeConn({ janelaExpiraEm: new Date(Date.now() + 60 * 60 * 1000) });
  const { server, port } = await startApp(conn);
  try {
    const big = Buffer.alloc(16 * 1024 * 1024 + 1, 0x41); // 16MB + 1 byte
    const mp = buildMultipart({
      filename: 'grande.pdf', contentType: 'application/pdf', buffer: big,
    });
    const r = await postMultipart(port, '/api/conversas/7/arquivos', mp);
    assert.equal(r.status, 415);
    assert.equal(r.body.error, 'Arquivo excede 16MB.');
  } finally { server.close(); }
});

test('upload: nenhum arquivo enviado → 400', async () => {
  global.fetch = async () => { throw new Error('não deveria chamar a Graph'); };
  const conn = fakeConn({ janelaExpiraEm: new Date(Date.now() + 60 * 60 * 1000) });
  const { server, port } = await startApp(conn);
  try {
    const mp = buildMultipart({ textFields: { legenda: 'sem arquivo' } });
    const r = await postMultipart(port, '/api/conversas/7/arquivos', mp);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Nenhum arquivo enviado');
  } finally { server.close(); }
});

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });
