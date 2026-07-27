'use strict';
const test = require('node:test');
const assert = require('node:assert');
const hist = require('../ia/historico');

test('carrega turnos em ordem e reconstrói o formato neutro', async () => {
  const conn = { async execute(sql) {
    if (sql.includes('SELECT')) return { rows: [
      { PAPEL: 'user', CONTEUDO: 'vendas junho', TOOL_JSON: null },
      { PAPEL: 'assistant', CONTEUDO: '', TOOL_JSON: JSON.stringify({ toolCallId: 't1', nome: 'consultar_vendas', args: { data_ini: '2026-06-01' } }) },
    ] };
    return { rows: [] };
  } };
  const msgs = await hist.carregar(conn, 88);
  assert.equal(msgs[0].papel, 'user');
  assert.equal(msgs[1].toolCallId, 't1');
});

test('salva incrementando o número do turno', async () => {
  const vistos = [];
  const conn = { async execute(sql, binds) {
    if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 2 }] };
    vistos.push({ sql, binds }); return { rows: [] };
  } };
  await hist.salvar(conn, 88, 'user', { texto: 'oi' });
  const ins = vistos.find((v) => v.sql.includes('INSERT INTO MC_ZAP_IA_TURNO'));
  assert.equal(ins.binds.n, 3);
  assert.equal(ins.binds.papel, 'user');
});
