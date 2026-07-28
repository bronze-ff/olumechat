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

test('decodificarTexto: latin1 (WE8MSWIN1252) não vira mojibake', () => {
  const buf = Buffer.from('Pão de queijo', 'latin1');
  assert.equal(extrair.decodificarTexto(buf), 'Pão de queijo');
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
