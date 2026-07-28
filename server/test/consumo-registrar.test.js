// consumo/registrar.js — FIL-77: gravação de consumo é BEST-EFFORT (nunca pode
// derrubar nem atrasar o atendimento, ver docs/SEGURANCA.md). Estes testes não
// tocam banco real — a conexão é um duble que captura o SQL/binds.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const registrar = require('../consumo/registrar');
const limitePlano = require('../ia/limitePlano');

function fakeConn({ falharEm = null } = {}) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      cap.push({ sql, binds });
      if (falharEm && falharEm.test(sql)) throw new Error('banco fora do ar (simulado)');
      return { rows: [] };
    },
  };
}

test('registrar: grava o evento com tenant_id/tipo/quantidade/custo corretos', async () => {
  const conn = fakeConn();
  await registrar.registrar(conn, 42, { tipo: 'mensagem_enviada', quantidade: 1, referencia: 99 });
  const ins = conn.cap.find((c) => /INSERT INTO consumo_evento/i.test(c.sql));
  assert.ok(ins, 'não gravou o evento');
  assert.equal(ins.binds.tenantId, 42);
  assert.equal(ins.binds.tipo, 'mensagem_enviada');
  assert.equal(ins.binds.qtd, 1);
  assert.equal(ins.binds.ref, 99);
  assert.equal(ins.binds.custo, null);
});

test('registrar: tipo inválido é descartado sem lançar (não é um dos 4 tipos do ticket)', async () => {
  const conn = fakeConn();
  await assert.doesNotReject(registrar.registrar(conn, 1, { tipo: 'coisa_inventada', quantidade: 1 }));
  assert.equal(conn.cap.filter((c) => /INSERT INTO consumo_evento/i.test(c.sql)).length, 0);
});

test('REGRESSÃO SEGURANCA.md: falha ao gravar o evento nunca propaga (medir não pode derrubar o atendimento)', async () => {
  const conn = fakeConn({ falharEm: /INSERT INTO consumo_evento/i });
  await assert.doesNotReject(registrar.registrar(conn, 1, { tipo: 'mensagem_enviada', quantidade: 1 }));
});

test('SAVEPOINT (achado de review do PR #26): falha no INSERT isola em SAVEPOINT — try/catch em JS sozinho NÃO recupera a transação do Postgres', async () => {
  const conn = fakeConn({ falharEm: /INSERT INTO consumo_evento/i });
  await registrar.registrar(conn, 1, { tipo: 'mensagem_enviada', quantidade: 1 });
  assert.ok(conn.cap.some((c) => /^SAVEPOINT/i.test(c.sql)), 'deveria abrir um SAVEPOINT antes do INSERT arriscado');
  assert.ok(
    conn.cap.some((c) => /^ROLLBACK TO SAVEPOINT/i.test(c.sql)),
    'sem ROLLBACK TO SAVEPOINT após a falha, o PRÓXIMO comando do chamador (salvar a mensagem, dar commit) falharia com "current transaction is aborted"'
  );
});

test('SAVEPOINT: caminho de sucesso libera o savepoint (RELEASE) em vez de deixar aberto', async () => {
  const conn = fakeConn();
  await registrar.registrar(conn, 1, { tipo: 'mensagem_enviada', quantidade: 1 });
  assert.ok(conn.cap.some((c) => /^SAVEPOINT/i.test(c.sql)));
  assert.ok(conn.cap.some((c) => /^RELEASE SAVEPOINT/i.test(c.sql)));
  assert.ok(!conn.cap.some((c) => /^ROLLBACK TO SAVEPOINT/i.test(c.sql)), 'sucesso não precisa de rollback');
});

// NOTA (merge com o fix da review do #22/FIL-78): registrarIaTokens() NÃO
// resolve mais o preço sozinho (chamar consumo/precos.js::carregarPreco()
// aqui dentro, com a conexão de tenant do chamador ainda aberta, era o MESMO
// defeito de conexão aninhada que aquele fix corrigiu para a credencial —
// ver o cabeçalho de consumo/registrar.js). Quem chama (ia/runtime.js,
// api/conversas.js) resolve o preço numa fase própria, fora de qualquer
// db.comTenant() em andamento, e passa o resultado pronto em `preco`.

test('registrarIaTokens: usa o `preco` já resolvido por quem chama para calcular custo_centavos', async () => {
  const conn = fakeConn();
  await registrar.registrarIaTokens(conn, 7, {
    tokensEntrada: 2000, tokensSaida: 1000,
    preco: { precoEntradaCentavos1k: 10, precoSaidaCentavos1k: 30 },
    referencia: 55,
  });
  const evt = conn.cap.find((c) => /INSERT INTO consumo_evento/i.test(c.sql));
  assert.ok(evt);
  assert.equal(evt.binds.tipo, 'ia_tokens');
  assert.equal(evt.binds.qtd, 3000, 'quantidade = tokens de entrada + saída');
  // 2000/1000*10 (entrada) + 1000/1000*30 (saída) = 20 + 30 = 50 centavos
  assert.equal(evt.binds.custo, 50);
  assert.equal(evt.binds.ref, 55);
});

test('registrarIaTokens: preco=null (não cadastrado ou não resolvido) → evento gravado com custo NULO, nunca inventado', async () => {
  const conn = fakeConn();
  await registrar.registrarIaTokens(conn, 7, { tokensEntrada: 100, tokensSaida: 50, preco: null });
  const evt = conn.cap.find((c) => /INSERT INTO consumo_evento/i.test(c.sql));
  assert.equal(evt.binds.qtd, 150);
  assert.equal(evt.binds.custo, null);
});

test('registrarIaTokens: sem tokens (provedor não devolveu uso) não grava nada', async () => {
  const conn = fakeConn();
  await registrar.registrarIaTokens(conn, 7, { tokensEntrada: 0, tokensSaida: 0 });
  assert.equal(conn.cap.length, 0);
});

test('registrarIaTokens: incrementa ia_consumo_mensal (teto do FIL-78) na mesma competência de limitePlano.anoMesAtual()', async () => {
  const conn = fakeConn();
  await registrar.registrarIaTokens(conn, 7, { tokensEntrada: 10, tokensSaida: 5 });
  const teto = conn.cap.find((c) => /INSERT INTO ia_consumo_mensal/i.test(c.sql));
  assert.ok(teto, 'não alimentou o teto do FIL-78 — ponto de extensão que a 015 deixou pronto');
  assert.equal(teto.binds.tenantId, 7);
  assert.equal(teto.binds.anoMes, limitePlano.anoMesAtual());
  assert.equal(teto.binds.tokens, 15);
  assert.match(teto.sql, /ON CONFLICT.*DO UPDATE.*tokens_usados = ia_consumo_mensal\.tokens_usados \+ EXCLUDED\.tokens_usados/is);
});

test('REGRESSÃO SEGURANCA.md: falha ao atualizar o teto (ia_consumo_mensal) não derruba o registro do evento nem propaga', async () => {
  const conn = fakeConn({ falharEm: /INSERT INTO ia_consumo_mensal/i });
  await assert.doesNotReject(registrar.registrarIaTokens(conn, 7, { tokensEntrada: 10, tokensSaida: 5 }));
  assert.ok(conn.cap.some((c) => /INSERT INTO consumo_evento/i.test(c.sql)), 'o evento em si já tinha sido gravado antes da falha no teto');
});

test('SAVEPOINT (achado de review do PR #26): falha ao atualizar ia_consumo_mensal também isola em SAVEPOINT', async () => {
  const conn = fakeConn({ falharEm: /INSERT INTO ia_consumo_mensal/i });
  await registrar.registrarIaTokens(conn, 7, { tokensEntrada: 10, tokensSaida: 5 });
  assert.ok(conn.cap.some((c) => /^ROLLBACK TO SAVEPOINT/i.test(c.sql)), 'a falha do teto também precisa recuperar a transação, não só a do evento');
});
