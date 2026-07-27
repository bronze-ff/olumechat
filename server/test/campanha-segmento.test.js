// Testes do wrapper de SELECT seguro das campanhas.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const seg = require('../campanha/segmento');

test('validarSql: rejeita não-SELECT e múltiplas statements', () => {
  assert.throws(() => seg.validarSql('DELETE FROM x'), /começar com SELECT/);
  assert.throws(() => seg.validarSql('SELECT 1 FROM x; DROP TABLE x'), /única consulta/);
  assert.throws(() => seg.validarSql('   '), /Escreva o SELECT/);
  // tolera ; final isolado
  assert.equal(seg.validarSql('SELECT 1 FROM x;'), 'SELECT 1 FROM x');
});

test('validarSql: tolera comentários ANTES do SELECT (-- e /* */)', () => {
  // o exemplo da UI começa com "-- Exemplo..."
  assert.equal(seg.validarSql('-- Exemplo (devedores)\nSELECT 1 FROM x'), 'SELECT 1 FROM x');
  assert.equal(seg.validarSql('/* bloco */ SELECT 1 FROM x'), 'SELECT 1 FROM x');
  assert.equal(seg.validarSql('-- a\n-- b\n/* c */\nSELECT 1 FROM x;'), 'SELECT 1 FROM x');
  // só comentário, sem SELECT → erro de vazio
  assert.throws(() => seg.validarSql('-- só comentário'), /Escreva o SELECT/);
  // comentário não pode "esconder" um DELETE
  assert.throws(() => seg.validarSql('-- x\nDELETE FROM t'), /começar com SELECT/);
});

test('extrairBinds: pega :nome e preenche com params (ou null)', () => {
  const b = seg.extrairBinds('SELECT * FROM p WHERE d > :dias AND f = :filial', { dias: 5 });
  assert.equal(b.dias, '5');
  assert.equal(b.filial, null);
});

test('rodarPreview: envolve em LIMIT (com alias de subquery) e decodifica colunas p/ minúsculas', async () => {
  let capturado;
  const conn = { async execute(sql, binds) {
    capturado = { sql, binds };
    return { rows: [{ TELEFONE: '5562999990000', NOME: 'Fulano' }] };
  } };
  const rows = await seg.rodarPreview(conn, 'SELECT telefone, nome FROM devedores', {}, 50);
  assert.match(capturado.sql, /SELECT \* FROM \(SELECT telefone, nome FROM devedores\) AS seg LIMIT :mczap_lim/);
  assert.equal(capturado.binds.mczap_lim, 50);
  assert.equal(rows[0].telefone, '5562999990000');
  assert.equal(rows[0].nome, 'Fulano');
});

test('contarTotal: envolve em COUNT(*) FROM (...) AS seg', async () => {
  let capturado;
  const conn = { async execute(sql) { capturado = sql; return { rows: [{ QTD: 1234 }] }; } };
  const total = await seg.contarTotal(conn, 'SELECT t FROM x WHERE a > :a', { a: 1 });
  assert.equal(total, 1234);
  assert.match(capturado, /SELECT COUNT\(\*\) AS QTD FROM \(SELECT t FROM x WHERE a > :a\) AS seg/);
});

test('rodarCompleto: aplica teto de segurança via LIMIT (sem maxRows no wrapper pg)', async () => {
  let capturado;
  const conn = { async execute(sql, binds) { capturado = { sql, binds }; return { rows: [] }; } };
  await seg.rodarCompleto(conn, 'SELECT t FROM x', {});
  assert.match(capturado.sql, /LIMIT :mczap_max/);
  assert.equal(capturado.binds.mczap_max, 100000);
});

test('preview propaga erro do banco (ex.: tabela sem GRANT)', async () => {
  const conn = { async execute() { const e = new Error('permission denied for table x'); throw e; } };
  await assert.rejects(() => seg.rodarPreview(conn, 'SELECT x FROM y', {}), /permission denied/);
});
