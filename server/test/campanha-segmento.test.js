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

test('CSV: acima do teto de linhas rejeita com erro claro (não trava o parse síncrono)', () => {
  const linhas = ['telefone'];
  for (let i = 0; i < 5; i++) linhas.push(`5562999990${String(i).padStart(3, '0')}`);
  const csv = linhas.join('\n');
  assert.throws(
    () => seg.parseCsv(csv, { limiteLinhas: 3 }),
    (err) => err instanceof seg.SegmentoInvalido && /mais de 3 linhas/.test(err.message)
  );
  // Dentro do teto, passa normalmente.
  assert.doesNotThrow(() => seg.parseCsv(csv, { limiteLinhas: 10 }));
});

test('CSV: validarImportacao propaga o teto de linhas pro parseCsv', () => {
  const linhas = ['telefone', '5562999990001', '5562999990002', '5562999990003'];
  assert.throws(
    () => seg.validarImportacao(linhas.join('\n'), [], { limiteLinhas: 1 }),
    seg.SegmentoInvalido
  );
});

test('CSV: teto padrão vem de LIMITE_LINHAS_PADRAO (50.000) quando não informado', () => {
  assert.equal(seg.LIMITE_LINHAS_PADRAO, 50000);
});
