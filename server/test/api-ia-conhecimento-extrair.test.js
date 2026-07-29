'use strict';
process.env.META_APP_SECRET = 'x'; process.env.WEBHOOK_VERIFY_TOKEN = 'x'; process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = 'x'; process.env.WA_BUSINESS_ACCOUNT_ID = 'x'; process.env.JWT_SECRET = 'seg-teste-32-chars-abcdefghijk';
// FIL-86 — POST /api/ia-conhecimento/extrair: extrai texto de PDF/XLSX/CSV e
// devolve blocos PROPOSTOS. Pontos que estes testes seguram:
//  - a rota é STATELESS: nunca grava em ia_conhecimento nem audita, com ou
//    sem erro (quem persiste é o CRUD normal, FIL-83);
//  - papel errado / add-on desligado seguem o mesmo gate do resto de
//    /api/ia-conhecimento;
//  - PDF escaneado → 422 com a mensagem certa; formatos/limites → 400 antes
//    de mostrar qualquer preview.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db/pool');
const perfilStore = require('../ia/perfilStore');

const rotas = require('../api/iaPerfil');

const TENANT = 92002;
const FIXTURES = path.join(__dirname, 'fixtures');

function servidor(papel = 'ADMIN', tenantId = TENANT) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { matricula: 10, tenantId }; req.perfil = { atendenteId: 1, papel }; req.tenantId = tenantId; next();
  });
  app.use('/api/ia-conhecimento', rotas.conhecimento);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

/** Banco falso — só precisa responder o gate de add-on e a contagem de blocos
 *  usada pelo teto de 50 antes do preview. NUNCA deveria receber um INSERT. */
function banco({ iaHabilitada = 'S', totalBlocos = 0 } = {}) {
  const estado = { escritas: [], auditoria: [] };
  db.getConnection = async () => ({
    async execute(sql, b = {}) {
      if (/^(SET|SELECT set_config|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql)) return { rows: [] };
      if (sql.includes('SELECT ia_habilitada')) return { rows: [{ IA_HABILITADA: iaHabilitada }] };
      if (sql.includes('count(*)') && sql.includes('ia_conhecimento')) return { rows: [{ N: totalBlocos }] };
      if (sql.includes('INSERT INTO auditoria')) { estado.auditoria.push(b); return { rows: [] }; }
      estado.escritas.push({ sql, binds: b });
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  });
  return estado;
}

function buildMultipart({ field = 'arquivo', filename, contentType, buffer, semArquivo = false }) {
  const boundary = '----olumeTestBoundary123';
  const parts = [];
  if (!semArquivo) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
      + `Content-Type: ${contentType}\r\n\r\n`
    ));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function postMultipart(app, urlPath, multipart) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const r = http.request({
        method: 'POST', hostname: '127.0.0.1', port: srv.address().port, path: urlPath,
        headers: { 'content-type': multipart.contentType, 'content-length': multipart.body.length },
      }, (res) => {
        let out = ''; res.on('data', (c) => (out += c));
        res.on('end', () => { srv.close(); let body = null; try { body = out ? JSON.parse(out) : null; } catch { /* não-JSON */ }
          resolve({ status: res.statusCode, body }); });
      });
      r.on('error', reject);
      r.write(multipart.body);
      r.end();
    });
  });
}

async function bufferXlsx(montar) {
  const wb = new ExcelJS.Workbook();
  montar(wb);
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// Permissão / add-on — mesmo gate do resto de /api/ia-conhecimento
// ---------------------------------------------------------------------------
test('extrair: papel diferente de ADMIN → 403', async () => {
  banco();
  for (const papel of ['SUPERVISOR', 'AUDITOR', 'ATENDENTE']) {
    const mp = buildMultipart({ filename: 'cardapio.pdf', contentType: 'application/pdf', buffer: Buffer.from('x') });
    const r = await postMultipart(servidor(papel), '/api/ia-conhecimento/extrair', mp);
    assert.equal(r.status, 403, papel);
  }
});

test('extrair: add-on de IA desligado → 400', async () => {
  banco({ iaHabilitada: 'N' });
  const mp = buildMultipart({ filename: 'cardapio.pdf', contentType: 'application/pdf', buffer: Buffer.from('x') });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 400);
});

test('extrair: nenhum arquivo enviado → 400', async () => {
  banco();
  const mp = buildMultipart({ semArquivo: true });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /nenhum arquivo/i);
});

test('extrair: formato não suportado (.txt) → 400', async () => {
  banco();
  const mp = buildMultipart({ filename: 'notas.txt', contentType: 'text/plain', buffer: Buffer.from('oi') });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /pdf|xlsx|csv/i);
});

test('extrair: arquivo acima de 10MB → 400, antes de processar', async () => {
  banco();
  const grande = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
  const mp = buildMultipart({ filename: 'grande.csv', contentType: 'text/csv', buffer: grande });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /10 ?MB/i);
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
test('extrair: PDF com texto → bloco proposto fiel, título = nome do arquivo', async () => {
  banco();
  const buffer = fs.readFileSync(path.join(FIXTURES, 'cardapio-texto.pdf'));
  const mp = buildMultipart({ filename: 'Cardápio Pizzaria.pdf', contentType: 'application/pdf', buffer });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.blocos.length, 1);
  assert.equal(r.body.blocos[0].titulo, 'Cardápio Pizzaria');
  assert.match(r.body.blocos[0].conteudo, /Marguerita/);
});

test('extrair: PDF escaneado (sem camada de texto) → 422 com mensagem clara', async () => {
  banco();
  const buffer = fs.readFileSync(path.join(FIXTURES, 'cardapio-escaneado.pdf'));
  const mp = buildMultipart({ filename: 'cardapio.pdf', contentType: 'application/pdf', buffer });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /imagem/i);
});

// ---------------------------------------------------------------------------
// XLSX / CSV
// ---------------------------------------------------------------------------
test('extrair: XLSX → linhas rotuladas pelo cabeçalho', async () => {
  banco();
  const buffer = await bufferXlsx((wb) => {
    const ws = wb.addWorksheet('Cardápio');
    ws.addRow(['Produto', 'Preço']);
    ws.addRow(['Pizza Marguerita', 45]);
  });
  const mp = buildMultipart({
    filename: 'catalogo.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.blocos[0].conteudo, /Produto: Pizza Marguerita/);
  assert.match(r.body.blocos[0].conteudo, /Preço: 45/);
});

test('extrair: CSV latin1 com ponto-e-vírgula → linhas rotuladas, sem mojibake', async () => {
  banco();
  const buffer = Buffer.from('produto;descrição\nPão de queijo;quentinho', 'latin1');
  const mp = buildMultipart({ filename: 'produtos.csv', contentType: 'text/csv', buffer });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.blocos[0].conteudo, /descrição: quentinho/);
});

test('extrair: CSV vazio → 422', async () => {
  banco();
  const mp = buildMultipart({ filename: 'vazio.csv', contentType: 'text/csv', buffer: Buffer.from('') });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 422);
});

test('extrair: CSV acima de ~10.000 linhas → 400 antes de processar', async () => {
  banco();
  const linhas = ['produto,preco'];
  for (let i = 0; i < 10_050; i++) linhas.push(`item${i},1`);
  const buffer = Buffer.from(linhas.join('\n'), 'utf8');
  const mp = buildMultipart({ filename: 'catalogo-grande.csv', contentType: 'text/csv', buffer });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /linhas/i);
});

// ---------------------------------------------------------------------------
// Split em blocos + teto de 50 blocos por empresa
// ---------------------------------------------------------------------------
// Um único campo de planilha com parágrafos internos (\n\n) é o jeito mais
// simples de produzir, pelo caminho real da rota, um texto extraído >20k
// chars com fronteiras de parágrafo — sem depender do parser de PDF pra isso.
function textoGigante(nParagrafos) {
  const paragrafos = [];
  for (let i = 0; i < nParagrafos; i++) paragrafos.push(`Parágrafo ${i}: ` + 'conteúdo '.repeat(90));
  return paragrafos.join('\n\n');
}

test('extrair: acima de 20k divide em blocos numerados "Título (n/m)"', async () => {
  banco();
  const buffer = await bufferXlsx((wb) => {
    const ws = wb.addWorksheet('Manual');
    ws.addRow(['Texto']);
    ws.addRow([textoGigante(30)]);
  });
  const mp = buildMultipart({
    filename: 'manual.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.blocos.length >= 2, 'deveria ter dividido em mais de um bloco');
  assert.equal(r.body.blocos[0].titulo, `manual (1/${r.body.blocos.length})`);
  r.body.blocos.forEach((b) => assert.ok(b.conteudo.length <= 20_000));
});

test('extrair: geraria mais blocos do que o teto de 50 → 400, antes do preview', async () => {
  banco({ totalBlocos: 49 });
  const buffer = await bufferXlsx((wb) => {
    const ws = wb.addWorksheet('Catálogo enorme');
    ws.addRow(['Texto']);
    ws.addRow([textoGigante(200)]);
  });
  const mp = buildMultipart({
    filename: 'catalogo-enorme.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  const r = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mp);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /50/);
});

// ---------------------------------------------------------------------------
// Stateless de verdade — nem em sucesso, nem em erro
// ---------------------------------------------------------------------------
test('extrair: NUNCA grava nem audita — sucesso e erro (422) inclusive', async () => {
  const ok = banco();
  const bufferOk = fs.readFileSync(path.join(FIXTURES, 'cardapio-texto.pdf'));
  const mpOk = buildMultipart({ filename: 'cardapio.pdf', contentType: 'application/pdf', buffer: bufferOk });
  const rOk = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mpOk);
  assert.equal(rOk.status, 200);
  assert.equal(ok.escritas.length, 0);
  assert.equal(ok.auditoria.length, 0);

  const falho = banco();
  const bufferRuim = fs.readFileSync(path.join(FIXTURES, 'cardapio-escaneado.pdf'));
  const mpFalho = buildMultipart({ filename: 'cardapio.pdf', contentType: 'application/pdf', buffer: bufferRuim });
  const rFalho = await postMultipart(servidor('ADMIN'), '/api/ia-conhecimento/extrair', mpFalho);
  assert.equal(rFalho.status, 422);
  assert.equal(falho.escritas.length, 0);
  assert.equal(falho.auditoria.length, 0);
});

test.after(() => { perfilStore.invalidar(TENANT); });
