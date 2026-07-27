'use strict';
const test = require('node:test');
const assert = require('node:assert');
const seg = require('../campanha/segmento');

test('CSV aceita cabeçalho, variáveis e rejeita inválido, vazio e duplicado por 9º dígito', () => {
  const r = seg.validarImportacao('telefone;nome\n(62) 98342-3192;A\n;vazio\nabc;ruim\n556283423192;dup', ['nome']);
  assert.equal(r.aceitas.length, 1);
  assert.equal(r.rejeitadas.length, 3);
  assert.deepEqual(r.rejeitadas.map((x) => x.motivo), ['telefone_invalido', 'telefone_invalido', 'duplicado']);
  assert.equal(r.aceitas[0].variaveis[0], 'A');
});

test('CSV suporta aspas e vírgula sem executar conteúdo', () => {
  const r = seg.validarImportacao('phone,name\n+5562999990000,"A, B"', ['name']);
  assert.equal(r.aceitas[0].telefone, '5562999990000');
  assert.equal(r.aceitas[0].variaveis[0], 'A, B');
});

test('filtros de atributo usam apenas campos fixos e binds', () => {
  const r = seg.filtroAtributos({ optin: 'S', tag: 'vip', departamentoId: 4, numeroId: 9 });
  assert.match(r.texto, /ct\.optin/);
  assert.match(r.texto, /tags_contato/);
  assert.doesNotMatch(r.texto, /SELECT\s+1\s+FROM\s+.*:usuario/i);
  assert.equal(r.binds.f0, 'S');
  assert.equal(r.binds.f1, '["vip"]');
});

test('filtro não concatena valores fornecidos', () => {
  const r = seg.filtroAtributos({ tag: "vip'); DROP TABLE contato;--" });
  assert.doesNotMatch(r.texto, /DROP TABLE/);
  assert.equal(r.binds.f0, '["vip\'); DROP TABLE contato;--"]');
});
