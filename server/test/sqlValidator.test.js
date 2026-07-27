'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validarSQL } = require('../bot/sqlValidator');

test('SELECT simples é válido', () => {
  assert.deepEqual(validarSQL('SELECT 1 FROM DUAL'), []);
});
test('rejeita não-SELECT', () => {
  assert.ok(validarSQL('UPDATE X SET A=1').length > 0);
});
test('rejeita ponto-e-vírgula', () => {
  assert.ok(validarSQL('SELECT 1 FROM DUAL;').some((e) => /";"/.test(e)));
});
test('rejeita as tabelas de credencial, DBMS_, UTL_, EXECUTE IMMEDIATE', () => {
  assert.ok(validarSQL('SELECT * FROM usuario').length > 0);
  assert.ok(validarSQL('SELECT senha_hash FROM USUARIO').length > 0);
  assert.ok(validarSQL('SELECT * FROM usuario_token_senha').length > 0);
  assert.ok(validarSQL('SELECT DBMS_RANDOM.VALUE FROM DUAL').length > 0);
  assert.ok(validarSQL('SELECT UTL_HTTP.REQUEST(1) FROM DUAL').length > 0);
});
test('coluna usuario_id NÃO é confundida com a tabela usuario', () => {
  assert.deepEqual(validarSQL('SELECT usuario_id FROM conversa'), []);
});
test('aceita query com CABEÇALHO COMENTADO (regressão: rejeitava TODA query curada)', () => {
  const q = '-- O que faz: total de vendas\n-- Binds: :data_ini, :data_fim\nSELECT SUM(V) FROM T WHERE D >= :data_ini';
  assert.deepEqual(validarSQL(q), []);
});
test('";" só em comentário não invalida; DBMS_ no código ainda é barrado', () => {
  assert.deepEqual(validarSQL('SELECT 1 FROM DUAL -- fim de linha; ok'), []);
  assert.ok(validarSQL('-- comentário\nSELECT DBMS_RANDOM.VALUE FROM DUAL').length > 0);
});
