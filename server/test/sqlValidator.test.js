'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validarSQL } = require('../bot/sqlValidator');

test('SELECT simples é válido', () => {
  assert.deepEqual(validarSQL('SELECT 1'), []);
});
test('rejeita não-SELECT', () => {
  assert.ok(validarSQL('UPDATE X SET A=1').length > 0);
});
test('rejeita ponto-e-vírgula', () => {
  assert.ok(validarSQL('SELECT 1;').some((e) => /";"/.test(e)));
});
test('rejeita ia_config, pg_sleep, dblink, pg_read_file', () => {
  assert.ok(validarSQL('SELECT * FROM ia_config').length > 0);
  assert.ok(validarSQL('SELECT pg_sleep(5)').length > 0);
  assert.ok(validarSQL("SELECT * FROM dblink('conn', 'select 1') AS t(x int)").length > 0);
  assert.ok(validarSQL("SELECT pg_read_file('/etc/passwd')").length > 0);
});
test('rejeita set_config (mutação do contexto de tenant) mesmo sem parênteses colados', () => {
  assert.ok(validarSQL("SELECT set_config('app.current_tenant_id', '2', true)").length > 0);
  assert.ok(validarSQL("SELECT set_config ('app.current_tenant_id', '2', true)").length > 0);
});
test('rejeita SET/RESET (role ou GUC) — mutação de contexto por outro caminho', () => {
  assert.ok(validarSQL('SELECT 1 WHERE 1=1 SET ROLE admin').length > 0);
  assert.ok(validarSQL('SELECT 1 RESET ALL').length > 0);
  assert.ok(validarSQL('SELECT 1 SET SESSION AUTHORIZATION DEFAULT').length > 0);
});
test('SET/RESET não dá falso-positivo em identificador comum (ex.: "settings", "reset_em")', () => {
  assert.deepEqual(validarSQL('SELECT settings, reset_em FROM t'), []);
});
test('rejeita acesso a catálogo do sistema', () => {
  assert.ok(validarSQL('SELECT * FROM information_schema.tables').length > 0);
  assert.ok(validarSQL('SELECT * FROM pg_catalog.pg_roles').length > 0);
});
test('aceita query com CABEÇALHO COMENTADO (regressão: rejeitava TODA query curada)', () => {
  const q = '-- O que faz: total de vendas\n-- Binds: :data_ini, :data_fim\nSELECT SUM(v) FROM t WHERE d >= :data_ini';
  assert.deepEqual(validarSQL(q), []);
});
test('";" só em comentário não invalida; pg_sleep no código ainda é barrado', () => {
  assert.deepEqual(validarSQL('SELECT 1 -- fim de linha; ok'), []);
  assert.ok(validarSQL('-- comentário\nSELECT pg_sleep(1)').length > 0);
});
