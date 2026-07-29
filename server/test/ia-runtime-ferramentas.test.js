'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
// FIL-85 — as ferramentas por empresa DENTRO do turno da IA.
//
// Os testes de ia-ferramentas-schema.test.js provam a montagem do schema; estes
// provam o caminho inteiro: o que sai do banco chega ao provedor, o que o
// provedor devolve é executado (ou barrado), e o efeito aparece no tempo real.
//
// Três coisas que só quebram aqui:
//   1. o runtime esquecer de PASSAR o schema por tenant ao client;
//   2. o runtime executar ferramenta desligada porque o modelo insistiu;
//   3. a ação acontecer no banco e NÃO virar evento no bus (o atendente só
//      veria no polling de 60s).
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const store = require('../ia/iaConfigStore');
const client = require('../ia/client');
const auth = require('../ia/autorizacao');
const runtime = require('../ia/runtime');
const ferramentasStore = require('../ia/ferramentasStore');
const { subscribe } = require('../realtime/hub');

const TENANT = 5501;

/**
 * Conexão falsa completa o bastante para as 3 fases do runtime rodarem.
 * `rotas` sobrescreve/estende as respostas por regex.
 */
function conexao({ tags = [], ferramentas = [], template = null, extras = [] } = {}) {
  const rotas = [
    [/ia_habilitada/i, { rows: [{ IA_HABILITADA: 'S' }] }],
    [/SELECT fila_status FROM conversa/i, { rows: [{ FILA_STATUS: 'ia' }] }],
    [/FROM conversa\b/i, { rows: [{ ID: 88, CONTATO_ID: 7, NUMERO_ID: 2, TELEFONE: '5562999990000',
      PHONE_NUMBER_ID: '111', FILA_STATUS: 'ia', IA_MODO_TESTE: 'N' }] }],
    [/FROM tag WHERE tenant_id/i, { rows: tags.map((t) => ({ ID: t.id, NOME: t.nome })) }],
    [/FROM ia_ferramenta/i, { rows: ferramentas }],
    [/FROM ia_pedido_template/i, { rows: template ? [{ TITULO: template.titulo, CAMPOS: template.campos }] : [] }],
    ...extras,
  ];
  return {
    _ins: [],
    async execute(sql, binds = {}) {
      if (/^INSERT INTO ia_turno/i.test(sql.trim())) { this._ins.push({ sql, binds }); return { rows: [], rowsAffected: 1 }; }
      if (/FROM ia_turno/i.test(sql)) return { rows: [] };
      for (const [re, resposta] of rotas) {
        if (re.test(sql)) return typeof resposta === 'function' ? resposta(binds) : resposta;
      }
      this._ins.push({ sql, binds });
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
    escreveu(re) { return this._ins.filter((i) => re.test(i.sql)); },
  };
}

function prepararProvedor(responder) {
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) });
  const recebido = { ferramentas: null, chamadas: 0 };
  client.chamar = async ({ ferramentas }) => {
    recebido.ferramentas = ferramentas;
    recebido.chamadas += 1;
    return responder(recebido.chamadas);
  };
  return recebido;
}

const TEMPLATE = {
  titulo: 'Pedido de delivery',
  campos: [{ nome: 'sabor', rotulo: 'Sabor', tipo: 'opcoes', opcoes: ['Calabresa'], obrigatorio: true }],
};

const soTexto = () => ({ texto: 'Pronto!', toolCalls: [] });

test.beforeEach(() => ferramentasStore.invalidar());
test.afterEach(() => ferramentasStore.invalidar());

// ---------------------------------------------------------------------------
// O schema que chega ao provedor
// ---------------------------------------------------------------------------
test('o provedor recebe o schema DAQUELA empresa (tags como enum), não um schema global', async () => {
  const conn = conexao({ tags: [{ id: 3, nome: 'orçamento' }] });
  db.getConnection = async () => conn;
  const recebido = prepararProvedor(soTexto);

  await runtime.processarEntrada(TENANT, 88, 'oi');

  const porNome = Object.fromEntries((recebido.ferramentas || []).map((f) => [f.nome, f]));
  assert.ok(porNome.aplicar_tag, 'a empresa tem tag cadastrada: a ferramenta tem que ser oferecida');
  assert.deepEqual(porNome.aplicar_tag.propriedades.tag.enum, ['orçamento']);
  assert.ok(porNome.atualizar_ficha_contato, 'ligada por default');
  assert.ok(!porNome.registrar_pedido, 'desligada por default e sem template');
});

test('ferramenta desligada não é sequer DESCRITA ao provedor (custo por turno, não só guarda)', async () => {
  const conn = conexao({
    tags: [{ id: 3, nome: 'vip' }],
    ferramentas: [{ NOME: 'atualizar_ficha_contato', ATIVO: 'N' }, { NOME: 'aplicar_tag', ATIVO: 'N' }],
  });
  db.getConnection = async () => conn;
  const recebido = prepararProvedor(soTexto);

  await runtime.processarEntrada(TENANT, 88, 'oi');

  assert.deepEqual((recebido.ferramentas || []).map((f) => f.nome), ['transferir_para_humano']);
});

test('registrar_pedido ligada COM template chega ao provedor com os campos do template', async () => {
  const conn = conexao({ ferramentas: [{ NOME: 'registrar_pedido', ATIVO: 'S' }], template: TEMPLATE });
  db.getConnection = async () => conn;
  const recebido = prepararProvedor(soTexto);

  await runtime.processarEntrada(TENANT, 88, 'quero uma pizza');

  const pedido = (recebido.ferramentas || []).find((f) => f.nome === 'registrar_pedido');
  assert.ok(pedido);
  assert.deepEqual(pedido.obrigatorios, ['sabor']);
});

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------
test('a IA aplica a tag: grava na conversa, anota na timeline e publica no bus', async () => {
  const conn = conexao({
    tags: [{ id: 3, nome: 'Orçamento' }],
    extras: [[/SELECT tags FROM conversa/i, { rows: [{ TAGS: [] }] }]],
  });
  db.getConnection = async () => conn;
  prepararProvedor((n) => (n === 1
    ? { texto: '', toolCalls: [{ id: 't1', nome: 'aplicar_tag', args: { tag: 'Orçamento' } }] }
    : soTexto()));

  const eventos = [];
  const cancelar = subscribe((e) => eventos.push(e));
  try {
    await runtime.processarEntrada(TENANT, 88, 'quero um orçamento');
  } finally { cancelar(); }

  const upd = conn.escreveu(/^UPDATE conversa/i);
  assert.equal(upd.length, 1, 'a etiqueta tem que entrar na conversa');
  assert.equal(upd[0].binds.tags, JSON.stringify([3]));
  const nota = conn.escreveu(/INSERT INTO mensagem/i).find((i) => /'ia'/.test(i.sql) && /etiqueta/i.test(i.binds.txt || ''));
  assert.ok(nota, 'o atendente que assumir precisa ver o que a IA fez');
  assert.ok(eventos.some((e) => e.tipo === 'conversa' && e.conversaId === 88),
    'sem evento, a ação da IA só apareceria no polling de 60s');
});

test('modelo insiste numa ferramenta DESLIGADA: nada é executado e ele recebe o erro', async () => {
  const conn = conexao({
    tags: [{ id: 3, nome: 'vip' }],
    ferramentas: [{ NOME: 'aplicar_tag', ATIVO: 'N' }],
    extras: [[/SELECT tags FROM conversa/i, { rows: [{ TAGS: [] }] }]],
  });
  db.getConnection = async () => conn;
  prepararProvedor((n) => (n === 1
    // O histórico guarda chamadas antigas; o modelo repete um nome que já viu.
    ? { texto: '', toolCalls: [{ id: 't1', nome: 'aplicar_tag', args: { tag: 'vip' } }] }
    : soTexto()));

  await runtime.processarEntrada(TENANT, 88, 'oi');

  assert.equal(conn.escreveu(/^UPDATE conversa/i).length, 0, 'ferramenta desligada agiu mesmo assim');
  const turnoTool = conn._ins.find((i) => /INSERT INTO ia_turno/i.test(i.sql) && i.binds.papel === 'tool');
  assert.match(turnoTool.binds.tj, /não está disponível/i, 'o modelo precisa saber por que falhou');
});

test('a IA registra o pedido: rascunho gravado e evento de pedido no bus', async () => {
  const conn = conexao({
    ferramentas: [{ NOME: 'registrar_pedido', ATIVO: 'S' }],
    template: TEMPLATE,
    extras: [[/INSERT INTO ia_pedido /i, { rows: [{ ID: 77 }], rowsAffected: 1 }]],
  });
  db.getConnection = async () => conn;
  prepararProvedor((n) => (n === 1
    ? { texto: '', toolCalls: [{ id: 't1', nome: 'registrar_pedido', args: { sabor: 'Calabresa' } }] }
    : soTexto()));

  const eventos = [];
  const cancelar = subscribe((e) => eventos.push(e));
  try {
    await runtime.processarEntrada(TENANT, 88, 'quero uma calabresa');
  } finally { cancelar(); }

  assert.ok(eventos.some((e) => e.tipo === 'pedido' && e.pedidoId === 77 && e.status === 'rascunho'),
    'o badge do atendente aparece ao vivo (spec)');
  assert.equal(eventos.filter((e) => e.tipo === 'pedido')[0].tenantId, TENANT,
    'evento sem tenant não chega em SSE nenhum');
});

test('SEGURANÇA: o estado de ferramentas é lido com o tenant do turno', async () => {
  const vistos = [];
  const base = conexao({ tags: [] });
  const conn = { ...base, async execute(sql, binds = {}) { vistos.push({ sql, binds }); return base.execute.call(this, sql, binds); } };
  conn._ins = [];
  db.getConnection = async () => conn;
  prepararProvedor(soTexto);

  await runtime.processarEntrada(TENANT, 88, 'oi');

  const doEstado = vistos.filter((v) => /FROM (tag|ia_ferramenta|ia_pedido_template)/i.test(v.sql));
  assert.ok(doEstado.length >= 3, 'as três leituras do estado têm que acontecer');
  assert.ok(doEstado.every((v) => v.binds.tenantId === TENANT));
});
