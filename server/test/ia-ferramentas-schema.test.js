'use strict';
// FIL-85 — o schema que vai ao provedor deixou de ser global: é POR EMPRESA.
//
// O que estes testes seguram é o critério de aceite nº 1 da issue: ferramenta
// desligada (ou pedido sem template) NÃO aparece no schema enviado ao provedor.
// Não é só uma guarda de execução — é token que a empresa não paga por turno, e
// é o modelo não ficar sabendo de uma capacidade que ele não tem.
const test = require('node:test');
const assert = require('node:assert');
const operacoes = require('../ia/operacoes');
const tools = require('../ia/tools');
const store = require('../ia/ferramentasStore');

const TENANT = 4242;

const TEMPLATE = {
  titulo: 'Pedido de delivery',
  campos: [
    { nome: 'sabor', rotulo: 'Sabor', tipo: 'opcoes', opcoes: ['Calabresa'], obrigatorio: true },
    { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'numero', obrigatorio: false },
  ],
};

function nomes(estado) {
  return operacoes.schemasParaProvedor(estado).map((s) => s.nome);
}

// ---------------------------------------------------------------------------
// Defaults do catálogo
// ---------------------------------------------------------------------------
test('sem nada configurado valem os defaults: ficha e tag ligadas, pedido desligado', () => {
  const estado = { habilitacao: {}, tags: [{ id: 1, nome: 'orçamento' }], template: null };
  const lista = nomes(estado);
  assert.ok(lista.includes('atualizar_ficha_contato'));
  assert.ok(lista.includes('aplicar_tag'));
  assert.ok(!lista.includes('registrar_pedido'), 'pedido nasce desligado (spec)');
});

test('transferir_para_humano é FIXA: não está no catálogo configurável e nunca some', () => {
  assert.ok(!operacoes.CONFIGURAVEIS.some((op) => op.nome === 'transferir_para_humano'),
    'desligar a saída para humano prenderia o cliente com o robô');
  const desligarTudo = {
    habilitacao: { transferir_para_humano: 'N', atualizar_ficha_contato: 'N', aplicar_tag: 'N', registrar_pedido: 'N' },
    tags: [{ id: 1, nome: 'x' }], template: TEMPLATE,
  };
  assert.deepEqual(nomes(desligarTudo), ['transferir_para_humano']);
});

test('ferramenta desligada no banco some do schema (critério de aceite nº 1)', () => {
  const estado = { habilitacao: { atualizar_ficha_contato: 'N' }, tags: [{ id: 1, nome: 'vip' }], template: null };
  assert.ok(!nomes(estado).includes('atualizar_ficha_contato'));
  assert.ok(nomes(estado).includes('aplicar_tag'), 'desligar uma não desliga a outra');
});

// ---------------------------------------------------------------------------
// Schema dinâmico
// ---------------------------------------------------------------------------
test('aplicar_tag lista as tags DAQUELA empresa como enum', () => {
  const estado = { habilitacao: {}, tags: [{ id: 1, nome: 'orçamento' }, { id: 2, nome: 'reclamação' }], template: null };
  const schema = operacoes.schemasParaProvedor(estado).find((s) => s.nome === 'aplicar_tag');
  assert.deepEqual(schema.propriedades.tag.enum, ['orçamento', 'reclamação']);
  assert.deepEqual(schema.obrigatorios, ['tag']);
});

test('empresa sem nenhuma tag cadastrada não recebe aplicar_tag (enum vazio só geraria chamada inválida)', () => {
  assert.ok(!nomes({ habilitacao: {}, tags: [], template: null }).includes('aplicar_tag'));
});

test('registrar_pedido LIGADA mas SEM template não é oferecida ao modelo', () => {
  const estado = { habilitacao: { registrar_pedido: 'S' }, tags: [], template: null };
  assert.ok(!nomes(estado).includes('registrar_pedido'));
});

test('registrar_pedido ligada COM template ganha os parâmetros do template', () => {
  const estado = { habilitacao: { registrar_pedido: 'S' }, tags: [], template: TEMPLATE };
  const schema = operacoes.schemasParaProvedor(estado).find((s) => s.nome === 'registrar_pedido');
  assert.ok(schema, 'com template configurado a ferramenta aparece');
  assert.deepEqual(Object.keys(schema.propriedades), ['sabor', 'quantidade']);
  assert.deepEqual(schema.obrigatorios, ['sabor']);
  assert.match(schema.descricao, /Pedido de delivery/, 'o modelo precisa saber que formulário é esse');
});

test('a união com as tools de SQL continua valendo (o modelo recebe tudo igual)', () => {
  const estado = { habilitacao: {}, tags: [{ id: 1, nome: 'vip' }], template: null };
  const lista = tools.schemasParaProvedor(estado).map((s) => s.nome);
  assert.ok(lista.includes('transferir_para_humano'));
  assert.ok(lista.includes('aplicar_tag'));
});

// ---------------------------------------------------------------------------
// Guarda de EXECUÇÃO (não basta sumir do schema)
// ---------------------------------------------------------------------------
test('permitida() barra ferramenta desligada mesmo com o modelo insistindo no nome antigo', () => {
  const estado = { habilitacao: { aplicar_tag: 'N' }, tags: [{ id: 1, nome: 'vip' }], template: null };
  assert.equal(operacoes.permitida('aplicar_tag', estado), false);
  assert.equal(operacoes.permitida('transferir_para_humano', estado), true);
  assert.equal(operacoes.permitida('registrar_pedido', estado), false, 'desligada por default');
  assert.equal(operacoes.permitida('registrar_pedido', { habilitacao: { registrar_pedido: 'S' }, tags: [], template: null }),
    false, 'ligada mas sem template continua barrada na execução');
});

// ---------------------------------------------------------------------------
// Store por tenant
// ---------------------------------------------------------------------------
function connFake(rotas) {
  return {
    executadas: [],
    async execute(sql, binds = {}) {
      this.executadas.push({ sql, binds });
      for (const [re, resposta] of rotas) {
        if (re.test(sql)) return typeof resposta === 'function' ? resposta(binds) : resposta;
      }
      return { rows: [] };
    },
  };
}

test('carregar monta o estado do tenant e cacheia por 60s', async () => {
  store.invalidar();
  const conn = connFake([
    [/FROM tag/i, { rows: [{ ID: 7, NOME: 'vip' }] }],
    [/FROM ia_ferramenta/i, { rows: [{ NOME: 'registrar_pedido', ATIVO: 'S' }] }],
    [/FROM ia_pedido_template/i, { rows: [{ TITULO: 'Pedido', CAMPOS: TEMPLATE.campos }] }],
  ]);
  const estado = await store.carregar(conn, TENANT);
  assert.deepEqual(estado.tags, [{ id: 7, nome: 'vip' }]);
  assert.equal(estado.habilitacao.registrar_pedido, 'S');
  assert.equal(estado.template.titulo, 'Pedido');

  const antes = conn.executadas.length;
  await store.carregar(conn, TENANT);
  assert.equal(conn.executadas.length, antes, 'a segunda leitura sai do cache');

  store.invalidar(TENANT);
  await store.carregar(conn, TENANT);
  assert.ok(conn.executadas.length > antes, 'invalidar força a releitura — é o que a tela do admin chama');
  store.invalidar();
});

test('SEGURANÇA: o cache é por tenant (senão as tags de uma empresa vazam para outra)', async () => {
  store.invalidar();
  const conn = connFake([
    [/FROM tag/i, (b) => ({ rows: b.tenantId === 1 ? [{ ID: 1, NOME: 'tag-do-A' }] : [{ ID: 2, NOME: 'tag-do-B' }] }),
    ],
  ]);
  const a = await store.carregar(conn, 1);
  const b = await store.carregar(conn, 2);
  assert.deepEqual(a.tags, [{ id: 1, nome: 'tag-do-A' }]);
  assert.deepEqual(b.tags, [{ id: 2, nome: 'tag-do-B' }]);
  store.invalidar();
});

test('migração 022 pendente (42P01) degrada para os defaults em vez de derrubar o turno', async () => {
  store.invalidar();
  const erro = new Error('relation "ia_ferramenta" does not exist');
  erro.code = '42P01';
  const conn = connFake([
    [/FROM tag/i, { rows: [{ ID: 1, NOME: 'vip' }] }],
    [/FROM ia_ferramenta/i, () => { throw erro; }],
  ]);
  const silencio = console.error;
  console.error = () => {};
  try {
    const estado = await store.carregar(conn, TENANT);
    assert.deepEqual(estado.habilitacao, {});
    assert.equal(estado.template, null);
    assert.deepEqual(estado.tags, [{ id: 1, nome: 'vip' }], 'as tags continuam (a tabela existe desde a 001)');
  } finally { console.error = silencio; store.invalidar(); }
});

test('o enum de tags tem teto: o schema inteiro vai ao provedor a cada mensagem', async () => {
  store.invalidar();
  const conn = connFake([[/FROM tag/i, { rows: [] }]]);
  await store.carregar(conn, TENANT);
  const sel = conn.executadas.find((e) => /FROM tag/i.test(e.sql));
  assert.equal(sel.binds.limite, store.MAX_TAGS);
  assert.ok(store.MAX_TAGS <= 60);
  store.invalidar();
});
