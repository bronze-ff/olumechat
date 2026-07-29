'use strict';
// FIL-84 — autoria de mensagem (mensagem.origem).
//
// Guarda de REGRESSÃO ESTRUTURAL: varre o código de produção e exige que TODO
// `INSERT INTO mensagem` declare a coluna `origem`. Sem isto, um caminho de
// envio novo cai no DEFAULT 'sistema' da migração 021 e a timeline do atendente
// mente sobre quem falou — que é exatamente o obstáculo 8 do ticket. Um teste
// que só exercita os caminhos de hoje não pega o caminho de amanhã.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const ARQUIVOS = [
  'webhook/processEvent.js',
  'api/conversas.js',
  'bot/runtime.js',
  'fila/distribuidor.js',
  'ia/runtime.js',
  'ia/handoff.js',
];

/** Todos os `INSERT INTO mensagem ... VALUES` de um arquivo, com a linha. */
function inserts(texto) {
  const achados = [];
  const re = /INSERT INTO mensagem([\s\S]*?)VALUES/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    achados.push({ colunas: m[1], linha: texto.slice(0, m.index).split('\n').length });
  }
  return achados;
}

for (const rel of ARQUIVOS) {
  test(`${rel}: todo INSERT INTO mensagem declara a coluna origem`, () => {
    const texto = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    const achados = inserts(texto);
    assert.ok(achados.length > 0, `${rel} deveria ter ao menos um INSERT INTO mensagem`);
    for (const a of achados) {
      assert.match(a.colunas, /\borigem\b/i,
        `${rel}:${a.linha} — INSERT INTO mensagem sem a coluna origem (cairia no DEFAULT 'sistema')`);
    }
  });
}

test('os 5 valores de origem estão em uso no código de produção', () => {
  const tudo = ARQUIVOS.map((r) => fs.readFileSync(path.join(RAIZ, r), 'utf8')).join('\n');
  for (const v of ['cliente', 'atendente', 'ia', 'bot', 'sistema']) {
    assert.match(tudo, new RegExp(`'${v}'`), `nenhum caminho de envio grava origem '${v}'`);
  }
});

test('GET /:id/mensagens devolve a origem (a timeline precisa dela pro badge de IA)', () => {
  const conversas = fs.readFileSync(path.join(RAIZ, 'api/conversas.js'), 'utf8');
  const trecho = conversas.slice(conversas.indexOf("router.get('/:id/mensagens'"));
  const select = trecho.slice(0, trecho.indexOf('ORDER BY'));
  assert.match(select, /\borigem\b/, 'a rota de mensagens não devolve origem');
});
