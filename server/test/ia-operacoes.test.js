'use strict';
// FIL-84 — o executor de operações NOMEADAS nasce aqui.
//
// `ia/toolExecutor.js` só sabe uma coisa: ler um .sql curado do disco, validar
// SELECT-only e devolver linhas. "Transferir para um humano" não é consulta —
// é EFEITO, com transação, guarda de corrida e evento de tempo real. Não cabe
// naquele modelo, e forçar caberia (um .sql que faz UPDATE) quebraria a
// garantia de SELECT-only que protege o banco do texto livre do admin.
//
// Por isso: registro NOMEADO no código (nome → {schema, executar}), com o
// runtime roteando por tipo. A FIL-85 expande com as demais operações e a
// habilitação por tenant; aqui o mapa é fixo e tem uma entrada só.
const test = require('node:test');
const assert = require('node:assert');
const operacoes = require('../ia/operacoes');
const handoff = require('../ia/handoff');

const TENANT = 3;
const CTX = { conversaId: 88, contatoId: 3, numeroId: 2 };

test('o registro expõe transferir_para_humano com departamento e motivo OPCIONAIS', () => {
  const op = operacoes.porNome('transferir_para_humano');
  assert.ok(op, 'a operação tem que existir no registro');
  const schema = operacoes.schemasParaProvedor().find((s) => s.nome === 'transferir_para_humano');
  assert.ok(schema);
  assert.ok(schema.descricao && schema.descricao.length > 20, 'a descrição é o que ensina o modelo a usar');
  assert.deepEqual(Object.keys(schema.propriedades).sort(), ['departamento', 'motivo']);
  assert.deepEqual(schema.obrigatorios, [], 'a IA tem que poder transferir sem saber o departamento');
});

test('porNome devolve null para nome desconhecido (o runtime cai no caminho de SQL)', () => {
  assert.equal(operacoes.porNome('consultar_vendas'), null);
  assert.equal(operacoes.porNome(''), null);
  assert.equal(operacoes.porNome(undefined), null);
});

test('transferir_para_humano resolve o departamento pelo NOME e delega ao handoff', async () => {
  const chamadas = [];
  const nomeOriginal = handoff.acharDepartamentoPorNome;
  const transferirOriginal = handoff.transferirParaHumano;
  handoff.acharDepartamentoPorNome = async (conn, tid, nome) => { chamadas.push(['nome', tid, nome]); return 5; };
  handoff.transferirParaHumano = async (conn, tid, ctx, opts) => {
    chamadas.push(['transferir', tid, ctx, opts]);
    return { ok: true, departamentoId: 5, departamentoNome: 'Financeiro', filaStatus: 'aguardando', protocolo: 'P1',
      eventos: [{ tipo: 'fila', conversaId: 88, departamentoId: 5 }] };
  };
  try {
    const r = await operacoes.porNome('transferir_para_humano')
      .executar({}, TENANT, CTX, { departamento: 'Financeiro', motivo: 'cliente pediu boleto' });

    assert.equal(r.ok, true);
    assert.equal(r.transferido, true, 'o runtime usa esta flag para encerrar o turno na hora');
    assert.equal(r.departamento, 'Financeiro');
    assert.ok(r.mensagemCliente && /atendente/i.test(r.mensagemCliente), 'o cliente precisa saber que vai ser transferido');
    assert.ok(r.eventos.some((e) => e.tipo === 'fila'), 'os eventos de tempo real voltam para o runtime publicar');
    assert.deepEqual(chamadas[0], ['nome', TENANT, 'Financeiro']);
    assert.equal(chamadas[1][3].departamentoId, 5);
  } finally {
    handoff.acharDepartamentoPorNome = nomeOriginal;
    handoff.transferirParaHumano = transferirOriginal;
  }
});

test('departamento inexistente NÃO é erro: a cascata leva ao padrão do número', async () => {
  const nomeOriginal = handoff.acharDepartamentoPorNome;
  const transferirOriginal = handoff.transferirParaHumano;
  handoff.acharDepartamentoPorNome = async () => null; // a IA chutou um nome
  handoff.transferirParaHumano = async (conn, tid, ctx, opts) => {
    assert.equal(opts.departamentoId, null, 'nome inválido vira "sem preferência", não erro');
    return { ok: true, departamentoId: 9, departamentoNome: 'Atendimento', filaStatus: 'aguardando', protocolo: 'P1', eventos: [] };
  };
  try {
    const r = await operacoes.porNome('transferir_para_humano')
      .executar({}, TENANT, CTX, { departamento: 'Setor Que Não Existe' });
    assert.equal(r.ok, true);
    assert.equal(r.departamento, 'Atendimento');
  } finally {
    handoff.acharDepartamentoPorNome = nomeOriginal;
    handoff.transferirParaHumano = transferirOriginal;
  }
});

test('transferência recusada (atendente já assumiu) devolve ok:false e NÃO manda o cliente esperar', async () => {
  const transferirOriginal = handoff.transferirParaHumano;
  handoff.transferirParaHumano = async () => ({ ok: false, departamentoId: null, departamentoNome: null, filaStatus: null, protocolo: null, eventos: [] });
  try {
    const r = await operacoes.porNome('transferir_para_humano').executar({}, TENANT, CTX, {});
    assert.equal(r.ok, false);
    assert.ok(!r.transferido, 'sem transferência não pode haver despedida');
  } finally {
    handoff.transferirParaHumano = transferirOriginal;
  }
});

test('motivo gigante é truncado antes de virar nota na timeline', async () => {
  let recebido = null;
  const transferirOriginal = handoff.transferirParaHumano;
  const nomeOriginal = handoff.acharDepartamentoPorNome;
  handoff.acharDepartamentoPorNome = async () => null;
  handoff.transferirParaHumano = async (conn, tid, ctx, opts) => {
    recebido = opts.motivo;
    return { ok: true, departamentoId: null, departamentoNome: null, filaStatus: 'em_atendimento', protocolo: 'P1', eventos: [] };
  };
  try {
    await operacoes.porNome('transferir_para_humano').executar({}, TENANT, CTX, { motivo: 'x'.repeat(5000) });
    assert.ok(recebido.length <= 500, 'texto livre do modelo não pode entrar sem teto');
  } finally {
    handoff.transferirParaHumano = transferirOriginal;
    handoff.acharDepartamentoPorNome = nomeOriginal;
  }
});
