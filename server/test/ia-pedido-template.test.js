'use strict';
// FIL-85 — o template de pedido por empresa.
//
// Duas fronteiras diferentes, no mesmo módulo e de propósito:
//   1. o ADMIN salva o formulário  → normalizarTemplate (erro CLARO na tela)
//   2. o MODELO chama a ferramenta → validarPayload (erro que volta pra ele)
// A segunda é a que importa para a segurança: `args` é texto livre de um LLM.
const test = require('node:test');
const assert = require('node:assert');
const t = require('../ia/pedidoTemplate');

const PIZZA = {
  titulo: 'Pedido de delivery',
  campos: [
    { rotulo: 'Sabor', tipo: 'opcoes', opcoes: ['Calabresa', 'Marguerita'], obrigatorio: true },
    { rotulo: 'Quantidade', tipo: 'numero', obrigatorio: true },
    { rotulo: 'Retirar em', tipo: 'hora' },
    { rotulo: 'Data', tipo: 'data' },
    { rotulo: 'Observação', tipo: 'texto' },
  ],
};

// ---------------------------------------------------------------------------
// O que o admin salva
// ---------------------------------------------------------------------------
test('normaliza o template e deriva o nome técnico do rótulo', () => {
  const { template, erro } = t.normalizarTemplate(PIZZA);
  assert.equal(erro, undefined);
  assert.deepEqual(template.campos.map((c) => c.nome),
    ['sabor', 'quantidade', 'retirar_em', 'data', 'observacao']);
  assert.equal(template.campos[0].obrigatorio, true);
  assert.equal(template.campos[2].obrigatorio, false);
});

test('rótulo acentuado vira nome de parâmetro ASCII (é o que vai no schema do provedor)', () => {
  assert.equal(t.nomeTecnico('Endereço de entrega'), 'endereco_de_entrega');
  assert.equal(t.nomeTecnico('Nº do cartão'), 'n_do_cartao');
});

test('sem título, sem campo, ou com tipo inventado → erro claro para a tela', () => {
  assert.match(t.normalizarTemplate({ campos: [{ rotulo: 'x' }] }).erro, /título/i);
  assert.match(t.normalizarTemplate({ titulo: 'P', campos: [] }).erro, /pelo menos um campo/i);
  assert.match(t.normalizarTemplate({ titulo: 'P', campos: [{ rotulo: 'x', tipo: 'assinatura' }] }).erro, /Tipo inválido/i);
  assert.match(t.normalizarTemplate({ titulo: 'P', campos: [{ rotulo: 'x', tipo: 'opcoes', opcoes: [] }] }).erro, /ao menos uma/i);
});

test('dois campos com o mesmo nome interno são recusados (o schema teria chave repetida)', () => {
  const r = t.normalizarTemplate({ titulo: 'P', campos: [{ rotulo: 'Sabor' }, { rotulo: 'sabor' }] });
  assert.match(r.erro, /mesmo nome interno/i);
});

test('os tetos existem porque o template vai no prompt A CADA mensagem', () => {
  const muitos = Array.from({ length: t.LIMITES.campos + 1 }, (_, i) => ({ rotulo: `Campo ${i}` }));
  assert.match(t.normalizarTemplate({ titulo: 'P', campos: muitos }).erro, /no máximo 20 campos/i);
  const muitasOpcoes = Array.from({ length: t.LIMITES.opcoes + 1 }, (_, i) => `op${i}`);
  assert.match(t.normalizarTemplate({ titulo: 'P', campos: [{ rotulo: 'X', tipo: 'opcoes', opcoes: muitasOpcoes }] }).erro,
    /excede 30 opções/i);
});

// ---------------------------------------------------------------------------
// Template → parâmetros da ferramenta
// ---------------------------------------------------------------------------
test('campo obrigatório vira parâmetro obrigatório e `opcoes` vira ENUM', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  const { propriedades, obrigatorios } = t.parametrosDoTemplate(template);
  assert.deepEqual(obrigatorios, ['sabor', 'quantidade']);
  assert.deepEqual(propriedades.sabor.enum, ['Calabresa', 'Marguerita']);
  assert.equal(propriedades.quantidade.type, 'number');
  assert.equal(propriedades.data.type, 'string');
  assert.ok(/AAAA-MM-DD/.test(propriedades.data.description), 'o formato tem que estar escrito para o modelo');
});

// ---------------------------------------------------------------------------
// O que o modelo devolveu
// ---------------------------------------------------------------------------
test('payload válido guarda RÓTULO e TIPO junto do valor (template editado não corrompe pedido antigo)', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  const { payload, resumo, erro } = t.validarPayload(template, { sabor: 'Calabresa', quantidade: 2 });
  assert.equal(erro, undefined);
  assert.deepEqual(payload.campos.sabor, { rotulo: 'Sabor', tipo: 'opcoes', valor: 'Calabresa', posicao: 0 });
  assert.equal(payload.titulo, 'Pedido de delivery');
  assert.match(resumo, /Sabor: Calabresa/);
});

// Achado de review (P2, PR #33): `campos` vira jsonb e o Postgres NÃO preserva
// a ordem das chaves — ele canonicaliza. Sem posição explícita, a tela de
// conferência mostraria o pedido numa ordem que ninguém configurou.
test('cada campo guarda a POSIÇÃO do template (jsonb não preserva ordem de chave)', () => {
  const { template } = t.normalizarTemplate({
    titulo: 'Agendamento',
    // Ordem NÃO-alfabética e com chaves de tamanhos diferentes: é exatamente o
    // que a canonicalização do jsonb reordenaria.
    campos: [{ rotulo: 'Serviço' }, { rotulo: 'Data', tipo: 'data' }, { rotulo: 'Observação do cliente' }],
  });
  const { payload } = t.validarPayload(template, {
    servico: 'Corte', data: '2026-08-01', observacao_do_cliente: 'chego 10min antes',
  });
  assert.equal(payload.campos.servico.posicao, 0);
  assert.equal(payload.campos.data.posicao, 1);
  assert.equal(payload.campos.observacao_do_cliente.posicao, 2);
});

test('campo opcional em branco não desloca a posição dos que vieram depois', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  const { payload } = t.validarPayload(template, { sabor: 'Calabresa', quantidade: 1, observacao: 'sem cebola' });
  // 'observacao' é o 5º campo do template; data/hora ficaram em branco.
  assert.equal(payload.campos.observacao.posicao, 4);
  assert.ok(payload.campos.sabor.posicao < payload.campos.observacao.posicao);
});

test('faltou campo obrigatório: erro que ENSINA o modelo a perguntar antes', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  const r = t.validarPayload(template, { sabor: 'Calabresa' });
  assert.match(r.erro, /Faltou preencher: Quantidade/);
  assert.match(r.erro, /Pergunte ao cliente/);
});

test('opção fora da lista é recusada com a lista junto', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  const r = t.validarPayload(template, { sabor: 'Frango', quantidade: 1 });
  assert.match(r.erro, /Calabresa, Marguerita/);
});

test('o modelo escreve como fala: "calabresa", "12,5", "31/12/2026", "19h30"', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  const { payload } = t.validarPayload(template, {
    sabor: 'calabresa', quantidade: '12,5', data: '31/12/2026', retirar_em: '19h30',
  });
  assert.equal(payload.campos.sabor.valor, 'Calabresa', 'guarda SEMPRE a forma cadastrada');
  assert.equal(payload.campos.quantidade.valor, 12.5);
  assert.equal(payload.campos.data.valor, '2026-12-31');
  assert.equal(payload.campos.retirar_em.valor, '19:30');
});

test('data e hora impossíveis são recusadas (o modelo alucina calendário)', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  assert.match(t.validarPayload(template, { sabor: 'Calabresa', quantidade: 1, data: '2026-02-31' }).erro, /data válida/i);
  assert.match(t.validarPayload(template, { sabor: 'Calabresa', quantidade: 1, retirar_em: '99:99' }).erro, /hora válida/i);
  assert.match(t.validarPayload(template, { sabor: 'Calabresa', quantidade: 'duas' }).erro, /precisa ser um número/i);
});

test('campo que o modelo inventou é DESCARTADO, não vira erro de atendimento', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  const { payload, erro } = t.validarPayload(template, { sabor: 'Calabresa', quantidade: 1, cupom_secreto: 'x' });
  assert.equal(erro, undefined);
  assert.ok(!('cupom_secreto' in payload.campos));
});

test('texto livre do modelo entra com teto (nada de payload gigante no banco)', () => {
  const { template } = t.normalizarTemplate(PIZZA);
  const { payload } = t.validarPayload(template, { sabor: 'Calabresa', quantidade: 1, observacao: 'x'.repeat(5000) });
  assert.equal(payload.campos.observacao.valor.length, t.LIMITES.valorTexto);
});

test('sem template não há payload possível (a ferramenta nem devia ter sido oferecida)', () => {
  assert.match(t.validarPayload(null, { a: 1 }).erro, /Nenhum modelo de pedido/i);
  assert.match(t.validarPayload({ titulo: 'x', campos: [] }, {}).erro, /Nenhum modelo de pedido/i);
});

test('normalizarSalvo descarta lixo do jsonb e devolve null quando não sobra campo', () => {
  assert.equal(t.normalizarSalvo(null), null);
  assert.equal(t.normalizarSalvo({ titulo: 'P', campos: [{ nome: 'x' }] }), null, 'campo sem rótulo/tipo não vale');
  const bom = t.normalizarSalvo({ titulo: 'P', campos: [{ nome: 'x', rotulo: 'X', tipo: 'texto' }, { lixo: true }] });
  assert.equal(bom.campos.length, 1);
});
