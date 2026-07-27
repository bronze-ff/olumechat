// Testes do helper de binds (db/sql.js) — o tradutor :nome → $n que TODAS as
// ~244 queries do repo atravessam. Erro aqui vira bind trocado em produção.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { traduzir, tipos, nomesBinds } = require('../db/sql');

test('bind simples vira $1 na ordem de aparição', () => {
  const r = traduzir('SELECT * FROM contato WHERE telefone = :tel AND optin = :op',
    { tel: '5562999990000', op: 'S' });
  assert.equal(r.text, 'SELECT * FROM contato WHERE telefone = $1 AND optin = $2');
  assert.deepEqual(r.values, ['5562999990000', 'S']);
});

test('bind REPETIDO reusa o mesmo $n (não duplica o valor)', () => {
  const r = traduzir(
    'SELECT * FROM conversa WHERE id = :id OR pai_id = :id OR raiz_id = :id',
    { id: 7 }
  );
  assert.equal(r.text, 'SELECT * FROM conversa WHERE id = $1 OR pai_id = $1 OR raiz_id = $1');
  assert.deepEqual(r.values, [7]); // UM valor, não três
});

test('bind só em COMENTÁRIO de linha não conta como bind', () => {
  const sql = 'SELECT id FROM contato -- antes filtrava por :codcli\nWHERE telefone = :tel';
  const r = traduzir(sql, { tel: '556299' });
  assert.equal(r.text, 'SELECT id FROM contato -- antes filtrava por :codcli\nWHERE telefone = $1');
  assert.deepEqual(r.values, ['556299']);
});

test('bind só em COMENTÁRIO de bloco não conta como bind', () => {
  const r = traduzir('SELECT id /* TODO: voltar :codcli aqui */ FROM contato WHERE id = :id', { id: 3 });
  assert.equal(r.text, 'SELECT id /* TODO: voltar :codcli aqui */ FROM contato WHERE id = $1');
  assert.deepEqual(r.values, [3]);
});

test(':nome dentro de STRING literal não é bind', () => {
  const r = traduzir("SELECT ':naoehbind' AS rotulo FROM conversa WHERE id = :id", { id: 9 });
  assert.equal(r.text, "SELECT ':naoehbind' AS rotulo FROM conversa WHERE id = $1");
  assert.deepEqual(r.values, [9]);
});

test('aspas escapadas ("") dentro da string não confundem a varredura', () => {
  const r = traduzir("SELECT 'a''b :x c' AS s FROM t WHERE id = :id", { id: 1 });
  assert.equal(r.text, "SELECT 'a''b :x c' AS s FROM t WHERE id = $1");
  assert.deepEqual(r.values, [1]);
});

test('cast :: do Postgres não é confundido com bind', () => {
  const r = traduzir("SELECT tenant_id::text FROM conversa WHERE id = :id", { id: 5 });
  assert.equal(r.text, 'SELECT tenant_id::text FROM conversa WHERE id = $1');
  assert.deepEqual(r.values, [5]);
});

test('identificador entre aspas duplas é preservado', () => {
  const r = traduzir('SELECT "coluna :estranha" FROM t WHERE id = :id', { id: 2 });
  assert.equal(r.text, 'SELECT "coluna :estranha" FROM t WHERE id = $1');
});

test('RETURNING ... INTO :id vira RETURNING e expõe outNames', () => {
  const r = traduzir(
    'INSERT INTO tag (nome, cor) VALUES (:n, :c) RETURNING id INTO :id',
    { n: 'vip', c: '#fff', id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
  );
  assert.equal(r.text, 'INSERT INTO tag (nome, cor) VALUES ($1, $2) RETURNING id');
  assert.deepEqual(r.values, ['vip', '#fff']);
  assert.deepEqual(r.outNames, ['id']);
});

test('specs { val, type } entram no values pelo campo val', () => {
  const r = traduzir('UPDATE contato SET cgcent = :cgc, codcli = :cod WHERE id = :id', {
    cgc: { type: tipos.STRING, val: '12345678000199' },
    cod: { type: tipos.NUMBER, val: 42 },
    id: 8,
  });
  assert.deepEqual(r.values, ['12345678000199', 42, 8]);
});

test('bind no SQL sem valor no objeto é erro (análogo ao ORA-01008)', () => {
  assert.throws(
    () => traduzir('SELECT * FROM t WHERE a = :a AND b = :b', { a: 1 }),
    /bind :b sem valor/
  );
});

test('bind no objeto que não existe no SQL é erro (análogo ao ORA-01036)', () => {
  assert.throws(
    () => traduzir('SELECT * FROM t WHERE a = :a', { a: 1, sobrando: 2 }),
    /bind :sobrando não existe no SQL/
  );
});

test('bind de saída sem RETURNING INTO é erro (pega o INSERT mal portado)', () => {
  assert.throws(
    () => traduzir('INSERT INTO tag (nome) VALUES (:n)',
      { n: 'x', id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }),
    /sem cláusula RETURNING/
  );
});

test('valor undefined vira null (não some do array de values)', () => {
  const r = traduzir('UPDATE t SET a = :a WHERE id = :id', { a: undefined, id: 1 });
  assert.deepEqual(r.values, [null, 1]);
});

test('Date e Buffer passam como valor cru, não como spec', () => {
  const d = new Date('2026-01-01T00:00:00Z');
  const r = traduzir('UPDATE t SET ts = :ts WHERE id = :id', { ts: d, id: 1 });
  assert.equal(r.values[0], d);
});

// ---------- nomesBinds — usado por bot/runtime.js pra montar binds de SQL
// livre ANTES de ter os valores (por isso não dá pra chamar traduzir() ali). ----------

test('nomesBinds: extrai os nomes na ordem de aparição, sem duplicar repetido', () => {
  assert.deepEqual(
    nomesBinds('SELECT * FROM conversa WHERE id = :id OR pai_id = :id OR tel = :tel'),
    ['id', 'tel']
  );
});

test('nomesBinds: "::cast" do Postgres NÃO vira um bind fantasma', () => {
  // Regressão: uma regex `/:nome/` ingênua lê ":codigo::int" como dois binds
  // (`codigo` e `int`) porque o segundo ":" de "::" é seguido de letra.
  assert.deepEqual(nomesBinds('SELECT * FROM t WHERE id = :codigo::int'), ['codigo']);
  assert.deepEqual(nomesBinds('SELECT tenant_id::text, :a FROM t WHERE id = :b::bigint'), ['a', 'b']);
});

test('nomesBinds: ignora bind dentro de string, identificador entre aspas e comentário', () => {
  assert.deepEqual(nomesBinds("SELECT ':naoehbind' AS s FROM t WHERE id = :id"), ['id']);
  assert.deepEqual(nomesBinds('SELECT "coluna :estranha" FROM t WHERE id = :id'), ['id']);
  assert.deepEqual(nomesBinds('SELECT id FROM t -- filtra por :antigo\nWHERE x = :x'), ['x']);
});

test('nomesBinds: ":=" (atribuição) não é bind', () => {
  assert.deepEqual(nomesBinds('SELECT * FROM t WHERE id = :id'), ['id']);
  assert.deepEqual(nomesBinds('DO $$ BEGIN x := 1; END $$'), []);
});
