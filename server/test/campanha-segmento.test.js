// Testes do wrapper de SELECT seguro das campanhas.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const seg = require('../campanha/segmento');

test('validarSql: rejeita não-SELECT e múltiplas statements', () => {
  assert.throws(() => seg.validarSql('DELETE FROM X'), /começar com SELECT/);
  assert.throws(() => seg.validarSql('SELECT 1 FROM DUAL; DROP TABLE X'), /única consulta/);
  assert.throws(() => seg.validarSql('   '), /Escreva o SELECT/);
  // tolera ; final isolado
  assert.equal(seg.validarSql('SELECT 1 FROM DUAL;'), 'SELECT 1 FROM DUAL');
});

test('validarSql: tolera comentários ANTES do SELECT (-- e /* */)', () => {
  // o exemplo da UI começa com "-- Exemplo..."
  assert.equal(seg.validarSql('-- Exemplo (devedores)\nSELECT 1 FROM DUAL'), 'SELECT 1 FROM DUAL');
  assert.equal(seg.validarSql('/* bloco */ SELECT 1 FROM DUAL'), 'SELECT 1 FROM DUAL');
  assert.equal(seg.validarSql('-- a\n-- b\n/* c */\nSELECT 1 FROM DUAL;'), 'SELECT 1 FROM DUAL');
  // só comentário, sem SELECT → erro de vazio
  assert.throws(() => seg.validarSql('-- só comentário'), /Escreva o SELECT/);
  // comentário não pode "esconder" um DELETE
  assert.throws(() => seg.validarSql('-- x\nDELETE FROM T'), /começar com SELECT/);
});

test('extrairBinds: pega :nome e preenche com params (ou null)', () => {
  const b = seg.extrairBinds('SELECT * FROM P WHERE D > :dias AND F = :filial', { dias: 5 });
  assert.equal(b.dias, '5');
  assert.equal(b.filial, null);
});

test('rodarPreview: envolve em ROWNUM e decodifica colunas p/ minúsculas', async () => {
  let capturado;
  const conn = { async execute(sql, binds) {
    capturado = { sql, binds };
    return { rows: [{ TELEFONE: '5562999990000', NOME: 'Fulano' }] };
  } };
  const rows = await seg.rodarPreview(conn, 'SELECT telefone, nome FROM devedores', {}, 50);
  // bind começa com LETRA — ':__lim' dava ORA-01036 no Oracle de verdade
  assert.match(capturado.sql, /SELECT \* FROM \(SELECT telefone, nome FROM devedores\) WHERE ROWNUM <= :mczap_lim/);
  assert.equal(capturado.binds.mczap_lim, 50);
  assert.equal(rows[0].telefone, '5562999990000');
  assert.equal(rows[0].nome, 'Fulano');
});

test('contarTotal: envolve em COUNT(*) FROM (...)', async () => {
  let capturado;
  const conn = { async execute(sql) { capturado = sql; return { rows: [{ QTD: 1234 }] }; } };
  const total = await seg.contarTotal(conn, 'SELECT t FROM x WHERE a > :a', { a: 1 });
  assert.equal(total, 1234);
  assert.match(capturado, /SELECT COUNT\(\*\) AS QTD FROM \(SELECT t FROM x WHERE a > :a\)/);
});

test('preview propaga erro do Oracle (ex.: ORA-00942 falta GRANT)', async () => {
  const conn = { async execute() { const e = new Error('ORA-00942: table or view does not exist'); throw e; } };
  await assert.rejects(() => seg.rodarPreview(conn, 'SELECT x FROM MCCANAL.PCHISTCOB', {}), /ORA-00942/);
});
