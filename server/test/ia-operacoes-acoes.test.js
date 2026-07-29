'use strict';
// FIL-85 — as três ações da IA dentro da conversa.
//
// O que estes testes protegem, em uma frase cada:
//   ficha  — a IA só toca campo permitido, e DIZ o que sobrescreveu;
//   tag    — tag inexistente é erro de ferramenta, nunca criação silenciosa;
//   pedido — o payload é validado contra o template e guarda os RÓTULOS.
// E, nas três: toda ação vira nota na timeline com `origem='ia'`, senão o
// atendente que assume não faz ideia do que foi feito em nome da empresa.
const test = require('node:test');
const assert = require('node:assert');
const operacoes = require('../ia/operacoes');

const TENANT = 3;
const CTX = { conversaId: 88, contatoId: 7, numeroId: 2 };

/** Conexão falsa por rotas (mesmo padrão do test/ia-handoff.test.js). */
function fakeConn(rotas = []) {
  return {
    executadas: [],
    async execute(sql, binds = {}) {
      this.executadas.push({ sql, binds });
      for (const [re, resposta] of rotas) {
        if (re.test(sql)) return typeof resposta === 'function' ? resposta(binds) : resposta;
      }
      return { rows: [], rowsAffected: 1 };
    },
    nota() {
      const n = this.executadas.find((e) => /INSERT INTO mensagem/i.test(e.sql));
      return n ? n.binds : null;
    },
  };
}

const executar = (nome, conn, args) => operacoes.porNome(nome).executar(conn, TENANT, CTX, args);

// ===========================================================================
// atualizar_ficha_contato
// ===========================================================================
const FICHA_VAZIA = {
  NOME_COMPLETO: null, RAZAO_SOCIAL: null, NOME_FANTASIA: null, DOCUMENTO: null, EMAIL: null,
  TELEFONE_ALTERNATIVO: null, CEP: null, LOGRADOURO: null, NUMERO_ENDERECO: null,
  COMPLEMENTO: null, BAIRRO: null, CIDADE: null, UF: null,
};

test('ficha: grava só os campos enviados e devolve o que mudou', async () => {
  const conn = fakeConn([[/FROM contato/i, { rows: [{ ...FICHA_VAZIA }] }]]);
  const r = await executar('atualizar_ficha_contato', conn, {
    nome_completo: 'Maria de Souza', cidade: 'Goiânia', uf: 'go',
  });

  assert.equal(r.ok, true);
  assert.deepEqual(r.alterados.map((a) => a.campo).sort(), ['cidade', 'nome_completo', 'uf']);
  const upd = conn.executadas.find((e) => /^UPDATE contato/i.test(e.sql.trim()));
  assert.equal(upd.binds.nome_completo, 'Maria de Souza');
  assert.equal(upd.binds.uf, 'GO', 'a sigla entra normalizada');
  assert.equal(upd.binds.id, CTX.contatoId);
  assert.equal(upd.binds.tenantId, TENANT);
});

test('ficha: campo FORA da lista branca é ignorado (nada de codigo_externo/telefone/observações)', async () => {
  const conn = fakeConn([[/FROM contato/i, { rows: [{ ...FICHA_VAZIA }] }]]);
  const r = await executar('atualizar_ficha_contato', conn, {
    codigo_externo: 999, telefone: '5562988887777', observacoes: 'texto do atendente', tags_contato: '[1]',
  });
  assert.equal(r.alterados.length, 0, 'campo não permitido não vira UPDATE');
  assert.ok(!conn.executadas.some((e) => /^UPDATE contato/i.test(e.sql.trim())));
  const schema = operacoes.schemasParaProvedor().find((s) => s.nome === 'atualizar_ficha_contato');
  for (const proibido of ['codigo_externo', 'telefone', 'observacoes']) {
    assert.ok(!(proibido in schema.propriedades), `${proibido} não pode nem ser oferecido ao modelo`);
  }
});

test('ficha: valor já preenchido é SOBRESCRITO, mas o anterior volta no resultado e na timeline', async () => {
  const conn = fakeConn([[/FROM contato/i, { rows: [{ ...FICHA_VAZIA, CIDADE: 'Anápolis' }] }]]);
  const r = await executar('atualizar_ficha_contato', conn, { cidade: 'Goiânia' });
  assert.deepEqual(r.alterados[0], { campo: 'cidade', rotulo: 'Cidade', de: 'Anápolis', para: 'Goiânia' });
  assert.match(conn.nota().txt, /antes: Anápolis/);
});

test('ficha: mesmo valor não vira escrita (nem nota na timeline)', async () => {
  const conn = fakeConn([[/FROM contato/i, { rows: [{ ...FICHA_VAZIA, CIDADE: 'Goiânia' }] }]]);
  const r = await executar('atualizar_ficha_contato', conn, { cidade: 'Goiânia' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.alterados, []);
  assert.deepEqual(r.inalterados, ['Cidade']);
  assert.equal(conn.nota(), null, 'timeline não pode encher de nota sem fato nenhum');
});

test('ficha: e-mail inválido é erro de ferramenta, não lixo no cadastro', async () => {
  const conn = fakeConn([[/FROM contato/i, { rows: [{ ...FICHA_VAZIA }] }]]);
  const r = await executar('atualizar_ficha_contato', conn, { email: 'maria arroba email' });
  assert.equal(r.ok, false);
  assert.match(r.erro, /e-mail/i);
  assert.ok(!conn.executadas.some((e) => /^UPDATE contato/i.test(e.sql.trim())));
});

test('ficha: documento entra só com dígitos e a ação fica na auditoria', async () => {
  const conn = fakeConn([[/FROM contato/i, { rows: [{ ...FICHA_VAZIA }] }]]);
  await executar('atualizar_ficha_contato', conn, { documento: '123.456.789-00' });
  const upd = conn.executadas.find((e) => /^UPDATE contato/i.test(e.sql.trim()));
  assert.equal(upd.binds.documento, '12345678900');
  const aud = conn.executadas.find((e) => /INSERT INTO auditoria/i.test(e.sql));
  assert.ok(aud, 'escrita da IA na ficha do cliente tem que deixar trilha');
  assert.match(aud.binds.det, /"por":"ia"/);
});

test('ficha: a nota da timeline nasce com origem=ia (não "sistema")', async () => {
  const conn = fakeConn([[/FROM contato/i, { rows: [{ ...FICHA_VAZIA }] }]]);
  const r = await executar('atualizar_ficha_contato', conn, { nome_completo: 'Maria' });
  const nota = conn.nota();
  assert.match(conn.executadas.find((e) => /INSERT INTO mensagem/i.test(e.sql)).sql, /'ia'/);
  assert.match(nota.txt, /🤖/);
  assert.ok(r.eventos.some((e) => e.tipo === 'conversa'), 'o atendente vê a nota ao vivo');
  assert.ok(r.eventos.some((e) => e.tipo === 'contato'), 'e a ficha aberta recarrega');
});

test('ficha: conversa sem contato vinculado não explode', async () => {
  const semContato = { ...CTX, contatoId: null };
  const r = await operacoes.porNome('atualizar_ficha_contato').executar(fakeConn(), TENANT, semContato, { cidade: 'x' });
  assert.equal(r.ok, false);
});

// ===========================================================================
// aplicar_tag
// ===========================================================================
test('tag: aplica a etiqueta existente sem perder as que já estavam', async () => {
  const conn = fakeConn([
    [/FROM tag WHERE tenant_id/i, { rows: [{ ID: 5, NOME: 'Orçamento' }] }],
    [/SELECT tags FROM conversa/i, { rows: [{ TAGS: [2] }] }],
  ]);
  const r = await executar('aplicar_tag', conn, { tag: 'orçamento' });
  assert.equal(r.ok, true);
  const upd = conn.executadas.find((e) => /^UPDATE conversa/i.test(e.sql.trim()));
  assert.equal(upd.binds.tags, JSON.stringify([2, 5]));
  assert.match(conn.nota().txt, /Orçamento/);
});

test('tag: inexistente é ERRO de ferramenta e nada é criado (critério de aceite)', async () => {
  const conn = fakeConn([
    [/lower\(nome\)/i, { rows: [] }],
    [/SELECT nome FROM tag/i, { rows: [{ NOME: 'vip' }, { NOME: 'orçamento' }] }],
  ]);
  const r = await executar('aplicar_tag', conn, { tag: 'cliente-chato' });
  assert.equal(r.ok, false);
  assert.match(r.erro, /não está cadastrada/i);
  assert.match(r.erro, /vip, orçamento/, 'o erro ensina quais existem');
  assert.ok(!conn.executadas.some((e) => /INSERT INTO tag/i.test(e.sql)), 'a IA não cria etiqueta');
  assert.ok(!conn.executadas.some((e) => /^UPDATE conversa/i.test(e.sql.trim())));
});

test('tag: repetir a mesma etiqueta não duplica nem polui a timeline', async () => {
  const conn = fakeConn([
    [/FROM tag WHERE tenant_id/i, { rows: [{ ID: 5, NOME: 'vip' }] }],
    [/SELECT tags FROM conversa/i, { rows: [{ TAGS: [5] }] }],
  ]);
  const r = await executar('aplicar_tag', conn, { tag: 'vip' });
  assert.equal(r.ok, true);
  assert.equal(r.jaAplicada, true);
  assert.ok(!conn.executadas.some((e) => /^UPDATE conversa/i.test(e.sql.trim())));
  assert.equal(conn.nota(), null);
});

test('tag: toda query da operação leva o tenant_id (isolamento)', async () => {
  const conn = fakeConn([
    [/FROM tag WHERE tenant_id/i, { rows: [{ ID: 5, NOME: 'vip' }] }],
    [/SELECT tags FROM conversa/i, { rows: [{ TAGS: null }] }],
  ]);
  await executar('aplicar_tag', conn, { tag: 'vip' });
  assert.ok(conn.executadas.every((e) => e.binds.tenantId === TENANT));
});

// ===========================================================================
// registrar_pedido
// ===========================================================================
const CAMPOS = [
  { nome: 'sabor', rotulo: 'Sabor', tipo: 'opcoes', opcoes: ['Calabresa'], obrigatorio: true },
  { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'numero', obrigatorio: true },
];

function connComTemplate(campos = CAMPOS) {
  return fakeConn([
    [/FROM ia_pedido_template/i, { rows: [{ TITULO: 'Pedido de delivery', CAMPOS: campos }] }],
    [/INSERT INTO ia_pedido /i, { rows: [{ ID: 501 }], rowsAffected: 1 }],
  ]);
}

test('pedido: valida contra o template, cria RASCUNHO e publica evento', async () => {
  const conn = connComTemplate();
  const r = await executar('registrar_pedido', conn, { sabor: 'calabresa', quantidade: '2' });

  assert.equal(r.ok, true);
  assert.equal(r.pedidoId, 501);
  const ins = conn.executadas.find((e) => /INSERT INTO ia_pedido /i.test(e.sql));
  assert.match(ins.sql, /'rascunho'/, 'nada vale antes de um humano conferir');
  const payload = JSON.parse(ins.binds.payload);
  assert.deepEqual(payload.campos.sabor, { rotulo: 'Sabor', tipo: 'opcoes', valor: 'Calabresa', posicao: 0 });
  assert.equal(payload.campos.quantidade.valor, 2);
  assert.equal(ins.binds.titulo, 'Pedido de delivery');
  assert.ok(r.eventos.some((e) => e.tipo === 'pedido' && e.pedidoId === 501), 'o badge do atendente aparece ao vivo');
  assert.match(conn.nota().txt, /Sabor: Calabresa/);
});

test('pedido: sem template configurado a ferramenta recusa (não deveria nem ter sido oferecida)', async () => {
  const conn = fakeConn([[/FROM ia_pedido_template/i, { rows: [] }]]);
  const r = await executar('registrar_pedido', conn, { sabor: 'Calabresa' });
  assert.equal(r.ok, false);
  assert.match(r.erro, /formulário de pedido/i);
  assert.ok(!conn.executadas.some((e) => /INSERT INTO ia_pedido /i.test(e.sql)));
});

test('pedido: faltando obrigatório NÃO grava e o erro ensina o modelo a perguntar', async () => {
  const conn = connComTemplate();
  const r = await executar('registrar_pedido', conn, { sabor: 'Calabresa' });
  assert.equal(r.ok, false);
  assert.match(r.erro, /Faltou preencher: Quantidade/);
  assert.ok(!conn.executadas.some((e) => /INSERT INTO ia_pedido /i.test(e.sql)));
});

test('pedido: o template é lido NA HORA da escrita, não do cache do schema', async () => {
  const conn = connComTemplate();
  await executar('registrar_pedido', conn, { sabor: 'Calabresa', quantidade: 1 });
  assert.ok(conn.executadas.some((e) => /FROM ia_pedido_template/i.test(e.sql)),
    'validar contra um template já trocado gravaria pedido com campo que não existe mais');
});

test('pedido: grava com o tenant e a conversa do contexto (isolamento)', async () => {
  const conn = connComTemplate();
  await executar('registrar_pedido', conn, { sabor: 'Calabresa', quantidade: 1 });
  const ins = conn.executadas.find((e) => /INSERT INTO ia_pedido /i.test(e.sql));
  assert.equal(ins.binds.tenantId, TENANT);
  assert.equal(ins.binds.cv, CTX.conversaId);
  assert.equal(ins.binds.ct, CTX.contatoId);
});
