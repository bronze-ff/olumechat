'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TOOLS, porNome, schemasParaProvedor } = require('../ia/tools');

// No Falatta o registro nasce VAZIO e é preenchido por tenant. Estes testes
// cobrem o contrato do registro, não um conjunto fixo de tools do cliente.

test('registro nasce vazio (nenhuma tool embutida no produto)', () => {
  assert.equal(TOOLS.length, 0);
  assert.equal(porNome('qualquer_coisa'), null);
});

test('porNome acha a tool registrada e devolve null pra desconhecida', () => {
  TOOLS.push({
    nome: 'consultar_exemplo',
    descricao: 'exemplo',
    arquivoSql: 'queries/exemplo.sql',
    parametros: [{ nome: 'data_ini', tipo: 'string', descricao: 'início', obrigatorio: true }],
  });
  try {
    assert.ok(porNome('consultar_exemplo'));
    assert.equal(porNome('inexistente'), null);
  } finally {
    TOOLS.length = 0; // não vaza pro próximo teste
  }
});

test('cada tool aponta para um .sql e lista parâmetros', () => {
  for (const t of TOOLS) {
    assert.match(t.arquivoSql, /\.sql$/);
    assert.ok(Array.isArray(t.parametros));
  }
});

test('schemasParaProvedor devolve um schema por tool, com obrigatórios', () => {
  TOOLS.push({
    nome: 'consultar_exemplo',
    descricao: 'exemplo',
    arquivoSql: 'queries/exemplo.sql',
    parametros: [
      { nome: 'data_ini', tipo: 'string', descricao: 'início', obrigatorio: true },
      { nome: 'filtro', tipo: 'string', descricao: 'opcional', obrigatorio: false },
    ],
  });
  try {
    const s = schemasParaProvedor();
    // FIL-84: a saída é a UNIÃO — tools de SQL primeiro, operações nomeadas
    // depois (ia/operacoes.js). O modelo recebe as duas coisas do mesmo jeito.
    const deSql = s.filter((x) => TOOLS.some((t) => t.nome === x.nome));
    assert.equal(deSql.length, TOOLS.length);
    assert.deepEqual(s[0].obrigatorios, ['data_ini']);
    assert.ok('filtro' in s[0].propriedades);
  } finally {
    TOOLS.length = 0;
  }
});

// FIL-84 — as operações NOMEADAS entram no MESMO schema que vai ao provedor.
// Sem isto o modelo nunca fica sabendo que pode transferir, e a ferramenta
// existe só no papel.
test('schemasParaProvedor inclui as operações nomeadas junto das tools de SQL', () => {
  const nomes = schemasParaProvedor().map((s) => s.nome);
  assert.ok(nomes.includes('transferir_para_humano'),
    'transferir_para_humano tem que ser oferecida ao provedor');
});
