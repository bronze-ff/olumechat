'use strict';
// Testes de server/ia/extrairArquivo.js (FIL-86) — módulo PURO (buffer in,
// texto/erro out), sem banco nem rede. A rota (server/api/iaPerfil.js
// POST /extrair) é quem decide o status HTTP; aqui só a extração em si.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const extrair = require('../ia/extrairArquivo');

const FIXTURES = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------
test('decodificarTexto: UTF-8 válido passa direto', () => {
  const buf = Buffer.from('Pão de queijo, café ☕', 'utf8');
  assert.equal(extrair.decodificarTexto(buf), 'Pão de queijo, café ☕');
});

test('decodificarTexto: latin1/Windows-1252 na faixa 0xA0–0xFF (idêntica nas duas) não vira mojibake', () => {
  const buf = Buffer.from('Pão de queijo', 'latin1');
  assert.equal(extrair.decodificarTexto(buf), 'Pão de queijo');
});

// P2 (review PR #31): buffer.toString('latin1') mapeia 0x80–0x9F pros
// controles C1 do ISO-8859-1 puro — mas CSV exportado pelo Excel Windows/BR
// usa Windows-1252 nessa faixa (€, aspas curvas, travessão). Um fallback em
// latin1 puro corrompe esses bytes em silêncio.
test('decodificarTexto: fallback usa Windows-1252 (0x93/0x94 aspas curvas, 0x80 euro), não latin1 puro', () => {
  const buf = Buffer.concat([
    Buffer.from('preco: ', 'utf8'),
    Buffer.from([0x80]), // € em Windows-1252
    Buffer.from(' '),
    Buffer.from([0x93]), // “ em Windows-1252
    Buffer.from('citação', 'latin1'), // 0xA0–0xFF é idêntico em latin1/cp1252
    Buffer.from([0x94]), // ” em Windows-1252
  ]);
  const texto = extrair.decodificarTexto(buf);
  assert.match(texto, /€/);
  assert.match(texto, /“citação”/);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
test('extrairCsv: delimitador vírgula, colunas rotuladas, linha em branco ignorada', () => {
  const csv = 'produto,preco\nPizza,45\n,\nRefrigerante,6';
  const texto = extrair.extrairCsv(Buffer.from(csv, 'utf8'));
  assert.equal(texto, 'produto: Pizza · preco: 45\nproduto: Refrigerante · preco: 6');
});

test('extrairCsv: detecta ponto-e-vírgula quando é o delimitador dominante', () => {
  const csv = 'produto;preco\nPizza;45,00';
  const texto = extrair.extrairCsv(Buffer.from(csv, 'utf8'));
  assert.equal(texto, 'produto: Pizza · preco: 45,00');
});

test('extrairCsv: encoding latin1 não vira mojibake', () => {
  const csv = 'produto;descrição\nPão;pãozinho quentinho';
  const texto = extrair.extrairCsv(Buffer.from(csv, 'latin1'));
  assert.match(texto, /descrição: pãozinho quentinho/);
});

test('extrairCsv: CSV do Excel Windows-1252 com aspas curvas (0x93/0x94) e euro (0x80) não corrompe', () => {
  const csv = Buffer.concat([
    Buffer.from('produto;obs\n', 'utf8'),
    Buffer.from('Pizza;', 'utf8'),
    Buffer.from([0x93]), Buffer.from('promo', 'utf8'), Buffer.from([0x94]),
    Buffer.from(' '), Buffer.from([0x80]), Buffer.from('5', 'utf8'),
  ]);
  const texto = extrair.extrairCsv(csv);
  assert.match(texto, /obs: “promo” €5/);
});

test('extrairCsv: arquivo vazio → ArquivoInvalido', () => {
  assert.throws(() => extrair.extrairCsv(Buffer.from('', 'utf8')), extrair.ArquivoInvalido);
});

test('extrairCsv: acima do teto de linhas → LimiteExcedido, antes de montar o texto todo', () => {
  const linhas = ['produto,preco'];
  for (let i = 0; i < 10; i++) linhas.push(`item${i},1`);
  const csv = linhas.join('\n');
  assert.throws(
    () => extrair.extrairCsv(Buffer.from(csv, 'utf8'), { limiteLinhas: 5 }),
    extrair.LimiteExcedido
  );
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------
async function bufferXlsx(montar) {
  const wb = new ExcelJS.Workbook();
  montar(wb);
  return wb.xlsx.writeBuffer();
}

test('extrairXlsx: uma linha de texto por registro, colunas rotuladas pelo cabeçalho', async () => {
  const buf = await bufferXlsx((wb) => {
    const ws = wb.addWorksheet('Cardápio');
    ws.addRow(['Produto', 'Preço']);
    ws.addRow(['Pizza Marguerita', 45]);
    ws.addRow(['Refrigerante', 6]);
  });
  const texto = await extrair.extrairXlsx(buf);
  assert.match(texto, /Produto: Pizza Marguerita/);
  assert.match(texto, /Preço: 45/);
  assert.match(texto, /Produto: Refrigerante/);
});

test('extrairXlsx: mais de uma planilha prefixa pelo nome da aba', async () => {
  const buf = await bufferXlsx((wb) => {
    const a = wb.addWorksheet('Bebidas');
    a.addRow(['Item']); a.addRow(['Água']);
    const b = wb.addWorksheet('Comidas');
    b.addRow(['Item']); b.addRow(['Pizza']);
  });
  const texto = await extrair.extrairXlsx(buf);
  assert.match(texto, /## Bebidas/);
  assert.match(texto, /## Comidas/);
});

test('extrairXlsx: acima do teto de linhas → LimiteExcedido', async () => {
  const buf = await bufferXlsx((wb) => {
    const ws = wb.addWorksheet('Grande');
    ws.addRow(['Item']);
    for (let i = 0; i < 20; i++) ws.addRow([`item${i}`]);
  });
  await assert.rejects(() => extrair.extrairXlsx(buf, { limiteLinhas: 5 }), extrair.LimiteExcedido);
});

test('extrairXlsx: planilha sem dados → ArquivoInvalido', async () => {
  const buf = await bufferXlsx((wb) => { wb.addWorksheet('Vazia'); });
  await assert.rejects(() => extrair.extrairXlsx(buf), extrair.ArquivoInvalido);
});

// P1 (review PR #31): o teto de 10MB do multer vale pros bytes COMPRIMIDOS.
// Um zip pequeno pode DECLARAR um tamanho descomprimido gigante no central
// directory (zip bomb) — `workbook.xlsx.load()` infla tudo em memória ANTES
// de qualquer checagem de linhas. Construímos um zip fake (só os cabeçalhos
// do central directory + EOCD; sem dado local nenhum) pra provar que a
// checagem roda e rejeita SEM nunca chamar o load do exceljs.
function construirZipComTamanhoDeclarado(tamanhoDescomprimido) {
  const nome = Buffer.from('x.xlsx', 'utf8');
  const cdEntry = Buffer.alloc(46 + nome.length);
  cdEntry.writeUInt32LE(0x02014b50, 0); // assinatura do central directory header
  cdEntry.writeUInt16LE(20, 4); cdEntry.writeUInt16LE(20, 6); cdEntry.writeUInt16LE(0, 8);
  cdEntry.writeUInt16LE(8, 10); cdEntry.writeUInt16LE(0, 12); cdEntry.writeUInt16LE(0, 14);
  cdEntry.writeUInt32LE(0, 16); // crc32
  cdEntry.writeUInt32LE(10, 20); // compressed size — pequeno de propósito
  cdEntry.writeUInt32LE(tamanhoDescomprimido, 24); // uncompressed size — DECLARADO gigante
  cdEntry.writeUInt16LE(nome.length, 28); cdEntry.writeUInt16LE(0, 30); cdEntry.writeUInt16LE(0, 32);
  cdEntry.writeUInt16LE(0, 34); cdEntry.writeUInt16LE(0, 36); cdEntry.writeUInt32LE(0, 38); cdEntry.writeUInt32LE(0, 42);
  nome.copy(cdEntry, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // assinatura do end-of-central-directory
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdEntry.length, 12);
  eocd.writeUInt32LE(0, 16); // offset do central directory = 0 (é o início do buffer)
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([cdEntry, eocd]);
}

test('somaTamanhoDescomprimidoXlsx: lê o tamanho declarado sem descomprimir nada', () => {
  const zip = construirZipComTamanhoDeclarado(200 * 1024 * 1024);
  assert.equal(extrair.somaTamanhoDescomprimidoXlsx(zip), 200 * 1024 * 1024);
});

test('somaTamanhoDescomprimidoXlsx: buffer que não é zip devolve null (deixa o load() decidir)', () => {
  assert.equal(extrair.somaTamanhoDescomprimidoXlsx(Buffer.from('não é um zip')), null);
});

test('extrairXlsx: zip bomb (tamanho descomprimido declarado > teto) → LimiteExcedido, sem tentar carregar', async () => {
  const zip = construirZipComTamanhoDeclarado(200 * 1024 * 1024); // 200MB declarado
  await assert.rejects(
    () => extrair.extrairXlsx(zip, { tetoDescomprimidoBytes: 50 * 1024 * 1024 }),
    extrair.LimiteExcedido
  );
});

test('extrairXlsx: arquivo real pequeno não é afetado pela checagem de zip bomb', async () => {
  const buf = await bufferXlsx((wb) => {
    const ws = wb.addWorksheet('Cardápio');
    ws.addRow(['Produto']); ws.addRow(['Pizza']);
  });
  assert.ok(extrair.somaTamanhoDescomprimidoXlsx(buf) < extrair.TETO_XLSX_DESCOMPRIMIDO_PADRAO);
  const texto = await extrair.extrairXlsx(buf);
  assert.match(texto, /Produto: Pizza/);
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
test('extrairPdf: PDF com camada de texto vira texto fiel', async () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'cardapio-texto.pdf'));
  const texto = await extrair.extrairPdf(buf);
  assert.match(texto, /Marguerita/);
  assert.match(texto, /45,00/);
});

test('extrairPdf: PDF sem camada de texto (escaneado) → ArquivoInvalido com mensagem clara', async () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'cardapio-escaneado.pdf'));
  await assert.rejects(
    () => extrair.extrairPdf(buf),
    (err) => err instanceof extrair.ArquivoInvalido && /imagem/.test(err.message)
  );
});

test('extrairPdf: arquivo corrompido/não-PDF → ArquivoInvalido', async () => {
  await assert.rejects(() => extrair.extrairPdf(Buffer.from('isto não é um PDF', 'utf8')), extrair.ArquivoInvalido);
});

// ---------------------------------------------------------------------------
// Divisão em blocos
// ---------------------------------------------------------------------------
test('propostaBlocos: texto dentro do limite vira UM bloco, sem numerar', () => {
  const blocos = extrair.propostaBlocos('Cardápio', 'pizza e refrigerante', 20_000);
  assert.deepEqual(blocos, [{ titulo: 'Cardápio', conteudo: 'pizza e refrigerante' }]);
});

test('propostaBlocos: acima do limite divide em fronteira de parágrafo e numera os títulos', () => {
  const paragrafos = [];
  for (let i = 0; i < 30; i++) paragrafos.push(`Parágrafo ${i}: ` + 'x'.repeat(800));
  const texto = paragrafos.join('\n\n'); // ~24.000+ chars
  const blocos = extrair.propostaBlocos('Manual', texto, 20_000);

  assert.ok(blocos.length >= 2, 'deveria ter dividido');
  assert.equal(blocos[0].titulo, `Manual (1/${blocos.length})`);
  assert.equal(blocos[blocos.length - 1].titulo, `Manual (${blocos.length}/${blocos.length})`);
  blocos.forEach((b) => assert.ok(b.conteudo.length <= 20_000));
  // corte em fronteira de parágrafo: cada bloco termina exatamente onde um
  // "Parágrafo N: ..." termina (nunca no meio de um).
  blocos.forEach((b) => assert.match(b.conteudo, /x{1,800}$/));
  // reconstrução exata: só a fronteira "\n\n" entre blocos foi consumida como corte.
  assert.equal(blocos.map((b) => b.conteudo).join('\n\n'), texto);
});

test('propostaBlocos: texto vazio não gera bloco nenhum', () => {
  assert.deepEqual(extrair.propostaBlocos('Vazio', '   ', 20_000), []);
});

// P2 (review PR #31): nome de arquivo longo (ou perto do limite + sufixo
// " (n/m)") gerava título > LIMITES.blocoTitulo (120) — o preview mostrava um
// bloco que o POST de salvar rejeitava. Trunca ANTES de montar o título.
test('propostaBlocos: nome de arquivo de 150 chars → título truncado em 120 (bloco único)', () => {
  const nomeLongo = 'x'.repeat(150);
  const blocos = extrair.propostaBlocos(nomeLongo, 'conteúdo pequeno', 20_000, 120);
  assert.equal(blocos.length, 1);
  assert.equal(blocos[0].titulo.length, 120);
});

test('propostaBlocos: split com nome perto do limite → título "base (n/m)" nunca passa do limite', () => {
  const nomeLongo = 'y'.repeat(118); // 118 + " (1/2)" (6 chars) estouraria 120
  const paragrafos = [];
  for (let i = 0; i < 30; i++) paragrafos.push(`Parágrafo ${i}: ` + 'x'.repeat(800));
  const texto = paragrafos.join('\n\n');
  const blocos = extrair.propostaBlocos(nomeLongo, texto, 20_000, 120);

  assert.ok(blocos.length >= 2, 'deveria ter dividido');
  blocos.forEach((b) => assert.ok(b.titulo.length <= 120, `título "${b.titulo}" (${b.titulo.length}) > 120`));
  assert.ok(blocos[0].titulo.endsWith(`(1/${blocos.length})`));
});

test('propostaBlocos: título curto não é afetado pelo truncamento', () => {
  const blocos = extrair.propostaBlocos('Cardápio', 'x'.repeat(30_000), 20_000, 120);
  assert.ok(blocos.length >= 2);
  assert.equal(blocos[0].titulo, `Cardápio (1/${blocos.length})`);
});
