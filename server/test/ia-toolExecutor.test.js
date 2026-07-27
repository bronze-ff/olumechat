// server/test/ia-toolExecutor.test.js
'use strict';
process.env.META_APP_SECRET = 'x'; process.env.WEBHOOK_VERIFY_TOKEN = 'x';
process.env.WA_TOKEN = 'x'; process.env.WA_PHONE_NUMBER_ID = 'x'; process.env.WA_BUSINESS_ACCOUNT_ID = 'x';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executar } = require('../ia/toolExecutor');
const { TOOLS } = require('../ia/tools');

const ARQ = 'queries/exemplo.sql';

// O registro nasce vazio no produto; os testes registram uma tool de mentira
// para exercitar o executor (leitura do .sql, validação SELECT-only, binds).
test.beforeEach(() => {
  TOOLS.length = 0;
  TOOLS.push({
    nome: 'consultar_exemplo',
    descricao: 'exemplo',
    arquivoSql: ARQ,
    parametros: [
      { nome: 'data_ini', tipo: 'string', descricao: 'início', obrigatorio: true },
      { nome: 'data_fim', tipo: 'string', descricao: 'fim', obrigatorio: true },
    ],
  });
});
test.afterEach(() => { TOOLS.length = 0; });

function dirComSql(conteudo, arquivo = ARQ) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'conh-'));
  fs.mkdirSync(path.join(base, 'queries'), { recursive: true });
  fs.writeFileSync(path.join(base, arquivo), conteudo);
  return base;
}

test('executa a tool, injeta binds e devolve todas as linhas', async () => {
  const base = dirComSql('SELECT CODFILIAL, VL FROM V WHERE DATA BETWEEN :data_ini AND :data_fim');
  let bindsVistos;
  const conn = { async execute(sql, binds) { bindsVistos = binds; return { rows: [{ CODFILIAL: 1, VL: 10 }, { CODFILIAL: 2, VL: 20 }] }; } };
  const r = await executar(conn, 'consultar_exemplo', { data_ini: '2026-06-01', data_fim: '2026-06-30' }, { conhecimentoDir: base });
  assert.equal(r.linhas.length, 2);
  assert.deepEqual(r.colunas, ['CODFILIAL', 'VL']);
  assert.equal(bindsVistos.data_ini, '2026-06-01');
});

test('rejeita SQL não-SELECT no arquivo', async () => {
  const base = dirComSql('DELETE FROM V');
  const conn = { async execute() { throw new Error('não deveria executar'); } };
  await assert.rejects(() => executar(conn, 'consultar_exemplo', {}, { conhecimentoDir: base }), /SELECT/);
});

test('tool desconhecida lança erro', async () => {
  await assert.rejects(() => executar({}, 'nao_existe', {}, { conhecimentoDir: '/x' }), /desconhecida/i);
});

test('corta em 100 linhas mesmo se o banco devolver mais (pool.js não implementa maxRows)', async () => {
  const base = dirComSql('SELECT X FROM V');
  const muitas = Array.from({ length: 250 }, (_, i) => ({ X: i }));
  const conn = { async execute() { return { rows: muitas }; } };
  const r = await executar(conn, 'consultar_exemplo', {}, { conhecimentoDir: base });
  assert.equal(r.linhas.length, 100);
});

test('SEGURANÇA (review PR #9): o teto vai no SQL — embrulha a query curada num subselect com LIMIT 100', async () => {
  // Antes o corte era só .slice() DEPOIS do await: o pg materializava e
  // trafegava TODAS as linhas antes do corte em JS. Agora o LIMIT tem que
  // estar no texto enviado ao banco, não só aplicado ao resultado em memória.
  const base = dirComSql('SELECT CODFILIAL, VL FROM V WHERE DATA BETWEEN :data_ini AND :data_fim');
  let sqlVisto;
  const conn = { async execute(sql) { sqlVisto = sql; return { rows: [] }; } };
  await executar(conn, 'consultar_exemplo', { data_ini: '2026-06-01', data_fim: '2026-06-30' }, { conhecimentoDir: base });
  assert.match(sqlVisto, /LIMIT\s+100\s*$/, 'query enviada ao banco não impõe o teto de linhas');
  assert.match(sqlVisto, /SELECT\s+CODFILIAL,\s*VL\s+FROM\s+V/, 'query curada original tem que estar embrulhada, não substituída');
});

test('query curada terminando em comentário na última linha não quebra o embrulho do LIMIT', async () => {
  // Regressão possível: se o LIMIT fosse colado sem quebra de linha depois de
  // uma query terminando em "-- comentário", o ") LIMIT 100" cairia dentro do
  // comentário e o SQL final ficaria com parêntese não fechado.
  const sql = 'SELECT X FROM T WHERE D >= :data_ini AND D < :data_fim -- filtro de período';
  const base = dirComSql(sql);
  let sqlVisto;
  const conn = { async execute(s) { sqlVisto = s; return { rows: [{ X: 1 }] }; } };
  const r = await executar(conn, 'consultar_exemplo', { data_ini: '2026-06-01', data_fim: '2026-06-30' }, { conhecimentoDir: base });
  assert.equal(r.linhas.length, 1);
  assert.match(sqlVisto, /LIMIT\s+100\s*$/, 'LIMIT ficou preso dentro do comentário da última linha');
});

test('aceita .sql com cabeçalho comentado e NÃO passa bind que só existe em comentário', async () => {
  // Regressão: os .sql curados começam com comentário e binds em comentários viravam
  // binds fantasmas (ORA-01036). Aqui o :fantasma está só no comentário.
  const sql = '-- header com :fantasma no comentário\nSELECT X FROM T WHERE D >= :data_ini AND D < :data_fim';
  const base = dirComSql(sql);
  let bindsVistos;
  const conn = { async execute(s, b) { bindsVistos = b; return { rows: [{ X: 1 }] }; } };
  const r = await executar(conn, 'consultar_exemplo', { data_ini: '2026-06-01', data_fim: '2026-06-30' }, { conhecimentoDir: base });
  assert.equal(r.linhas.length, 1);
  assert.ok('data_ini' in bindsVistos && 'data_fim' in bindsVistos);
  assert.ok(!('fantasma' in bindsVistos), 'bind que só aparece em comentário não é enviado ao banco');
});
