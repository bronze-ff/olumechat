// Testes do motor PURO do chatbot — replica o fluxo dos menus do EZChat.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { iniciar, avancar, aoExpirar, validarFluxo } = require('../bot/engine');

const CTX = { nome: 'Cliente', protocolo: '260610100042' };

// Fluxo de exemplo = menus dos prints (Financeiro→Crédito/Cobrança, T.I, Transporte c/ RCA).
const FLUXO = {
  versao: 1,
  config: {
    inicio: 'saudacao',
    timeoutMin: 30,
    acaoTimeout: { tipo: 'encerrar', texto: 'Encerrado por inatividade. Protocolo {{protocolo}}.' },
    msgOpcaoInvalida: 'Opção inválida. Digite apenas o número de uma das opções.',
    maxInvalidas: 3,
    acaoMaxInvalidas: { tipo: 'transferir', departamentoId: 1, texto: 'Vou te passar para um atendente.' },
  },
  nos: [
    { id: 'saudacao', tipo: 'mensagem', texto: 'Olá {{nome}}! Protocolo {{protocolo}}.', proximo: 'menu_principal' },
    { id: 'menu_principal', tipo: 'menu',
      texto: '1 - Financeiro\n2 - T.I\n3 - Transporte\n4 - Encerrar',
      opcoes: [
        { valor: '1', proximo: 'menu_financeiro' },
        { valor: '2', proximo: 'transfere_ti' },
        { valor: '3', proximo: 'pergunta_rca' },
        { valor: '4', proximo: 'encerra' },
      ] },
    { id: 'menu_financeiro', tipo: 'menu',
      texto: '1 - Crédito\n2 - Cobrança\n0 - Voltar',
      opcoes: [
        { valor: '1', proximo: 'transfere_credito' },
        { valor: '2', proximo: 'transfere_cobranca' },
        { valor: '0', proximo: 'menu_principal' },
      ] },
    { id: 'pergunta_rca', tipo: 'pergunta', texto: 'Qual o seu código RCA?', variavel: 'codigo_rca',
      validacao: 'numero', msgInvalida: 'Informe apenas números.', proximo: 'transfere_transporte' },
    { id: 'transfere_ti', tipo: 'transferir', departamentoId: 4, texto: 'Aguarde a equipe de T.I.' },
    { id: 'transfere_credito', tipo: 'transferir', departamentoId: 2 },
    { id: 'transfere_cobranca', tipo: 'transferir', departamentoId: 3 },
    { id: 'transfere_transporte', tipo: 'transferir', departamentoId: 5, texto: 'Obrigado! RCA {{codigo_rca}}.' },
    { id: 'encerra', tipo: 'encerrar', texto: 'Atendimento encerrado. Protocolo {{protocolo}}.' },
  ],
};

test('iniciar: emite saudação (com placeholders) + menu e espera', () => {
  const r = iniciar(FLUXO, CTX);
  assert.equal(r.mensagens.length, 2);
  assert.equal(r.mensagens[0], 'Olá Cliente! Protocolo 260610100042.');
  assert.match(r.mensagens[1], /1 - Financeiro/);
  assert.equal(r.estado.noAtual, 'menu_principal');
  assert.equal(r.acao, null);
});

test('menu: opção válida navega pro submenu', () => {
  const r0 = iniciar(FLUXO, CTX);
  const r = avancar(FLUXO, r0.estado, '1', CTX);
  assert.match(r.mensagens[0], /Crédito/);
  assert.equal(r.estado.noAtual, 'menu_financeiro');
});

test('menu: voltar (0) retorna ao menu principal', () => {
  const e = { noAtual: 'menu_financeiro', variaveis: {}, invalidas: 0 };
  const r = avancar(FLUXO, e, '0', CTX);
  assert.equal(r.estado.noAtual, 'menu_principal');
});

test('menu: transferência devolve a ação com o departamento', () => {
  const e = { noAtual: 'menu_principal', variaveis: {}, invalidas: 0 };
  const r = avancar(FLUXO, e, '2', CTX);
  assert.deepEqual(r.acao, { tipo: 'transferir', departamentoId: 4 });
  assert.match(r.mensagens[0], /T\.I/);
});

test('menu: opção inválida avisa, re-mostra o menu e conta', () => {
  const e = { noAtual: 'menu_principal', variaveis: {}, invalidas: 0 };
  const r = avancar(FLUXO, e, 'banana', CTX);
  assert.match(r.mensagens[0], /inválida/i);
  assert.match(r.mensagens[1], /1 - Financeiro/);
  assert.equal(r.estado.invalidas, 1);
  assert.equal(r.acao, null);
});

test('menu: 3ª inválida dispara acaoMaxInvalidas (transferir)', () => {
  const e = { noAtual: 'menu_principal', variaveis: {}, invalidas: 2 };
  const r = avancar(FLUXO, e, 'x', CTX);
  assert.deepEqual(r.acao, { tipo: 'transferir', departamentoId: 1 });
  assert.match(r.mensagens[0], /atendente/);
});

test('pergunta: resposta válida captura a variável e usa no placeholder', () => {
  const e = { noAtual: 'pergunta_rca', variaveis: {}, invalidas: 0 };
  const r = avancar(FLUXO, e, '371', CTX);
  assert.equal(r.estado.variaveis.codigo_rca, '371');
  assert.equal(r.mensagens[0], 'Obrigado! RCA 371.');
  assert.deepEqual(r.acao, { tipo: 'transferir', departamentoId: 5 });
});

test('pergunta: resposta inválida (validacao numero) pede de novo', () => {
  const e = { noAtual: 'pergunta_rca', variaveis: {}, invalidas: 0 };
  const r = avancar(FLUXO, e, 'abc', CTX);
  assert.match(r.mensagens[0], /apenas números/);
  assert.equal(r.acao, null);
});

test('encerrar pelo menu', () => {
  const e = { noAtual: 'menu_principal', variaveis: {}, invalidas: 0 };
  const r = avancar(FLUXO, e, '4', CTX);
  assert.deepEqual(r.acao, { tipo: 'encerrar' });
  assert.match(r.mensagens[0], /260610100042/);
});

test('timeout: aoExpirar executa acaoTimeout', () => {
  const r = aoExpirar(FLUXO, { noAtual: 'menu_principal', variaveis: {}, invalidas: 0 }, CTX);
  assert.deepEqual(r.acao, { tipo: 'encerrar' });
  assert.match(r.mensagens[0], /inatividade.*260610100042/);
});

test('estado perdido (nó não existe mais): recomeça do início', () => {
  const r = avancar(FLUXO, { noAtual: 'no_removido', variaveis: {}, invalidas: 0 }, 'oi', CTX);
  assert.equal(r.estado.noAtual, 'menu_principal'); // saudação caminhou até o menu
});

test('loop-guard: mensagens em círculo encerram por segurança', () => {
  const loop = {
    config: { inicio: 'a' },
    nos: [
      { id: 'a', tipo: 'mensagem', texto: 'A', proximo: 'b' },
      { id: 'b', tipo: 'mensagem', texto: 'B', proximo: 'a' },
    ],
  };
  const r = iniciar(loop, CTX);
  assert.deepEqual(r.acao, { tipo: 'encerrar' });
  assert.ok(r.mensagens.length <= 21);
});

test('validarFluxo: fluxo dos prints é válido', () => {
  assert.deepEqual(validarFluxo(FLUXO), []);
});

// ---------- nó consulta (validação no banco) ----------
const { continuarAposConsulta } = require('../bot/engine');

const FLUXO_CONSULTA = {
  config: { inicio: 'pergunta_rca', maxInvalidas: 3 },
  nos: [
    { id: 'pergunta_rca', tipo: 'pergunta', texto: 'Qual seu RCA?', variavel: 'codigo_rca',
      validacao: 'numero', proximo: 'valida_rca' },
    { id: 'valida_rca', tipo: 'consulta',
      sql: 'SELECT NOME FROM MCCANAL.PCUSUARI WHERE CODUSUR = :codigo_rca',
      seEncontrado: 'confirma', seNaoEncontrado: 'nao_achou' },
    { id: 'confirma', tipo: 'mensagem', texto: 'Achei: {{nome}} (RCA {{codigo_rca}})', proximo: 'fim' },
    { id: 'nao_achou', tipo: 'pergunta', texto: 'RCA não encontrado. Digite de novo:',
      variavel: 'codigo_rca', validacao: 'numero', proximo: 'valida_rca' },
    { id: 'fim', tipo: 'encerrar', texto: 'Ok!' },
  ],
};

test('consulta: resposta válida PARA no nó consulta com a ação pendente', () => {
  const e = { noAtual: 'pergunta_rca', variaveis: {}, invalidas: 0 };
  const r = avancar(FLUXO_CONSULTA, e, '1219', CTX);
  assert.equal(r.acao.tipo, 'consulta');
  assert.equal(r.acao.no.id, 'valida_rca');
  assert.equal(r.estado.variaveis.codigo_rca, '1219');
  assert.equal(r.estado.noAtual, 'valida_rca');
});

test('consulta: encontrado → colunas viram variáveis, segue seEncontrado até o fim', () => {
  const e = { noAtual: 'valida_rca', variaveis: { codigo_rca: '1219' }, invalidas: 0 };
  const r = continuarAposConsulta(FLUXO_CONSULTA, e, true, { nome: 'DAYANE' }, CTX);
  // caminha: mensagem (com a variável da consulta) → encerrar
  assert.deepEqual(r.mensagens, ['Achei: DAYANE (RCA 1219)', 'Ok!']);
  assert.deepEqual(r.acao, { tipo: 'encerrar' });
  assert.equal(r.estado.variaveis.nome, 'DAYANE');
});

test('consulta: NÃO encontrado → segue seNaoEncontrado (re-pergunta)', () => {
  const e = { noAtual: 'valida_rca', variaveis: { codigo_rca: '999' }, invalidas: 0 };
  const r = continuarAposConsulta(FLUXO_CONSULTA, e, false, {}, CTX);
  assert.match(r.mensagens[0], /não encontrado/);
  assert.equal(r.estado.noAtual, 'nao_achou'); // esperando nova resposta
  assert.equal(r.acao, null);
  assert.equal(r.estado.variaveis.nome, undefined); // vars da consulta NÃO entram
});

// ---------- nó irfluxo (vincular fluxos por nome) ----------
const FLUXO_IR = {
  config: { inicio: 'menu' },
  nos: [
    { id: 'menu', tipo: 'menu', texto: '1-Fin', opcoes: [{ valor: '1', proximo: 'vai_fin' }] },
    { id: 'vai_fin', tipo: 'irfluxo', fluxo: 'Menu Financeiro' },
  ],
};

test('irfluxo: menu → salto devolve ação irFluxo com o NOME do destino', () => {
  const e = { noAtual: 'menu', variaveis: { codigo_rca: '1219' }, invalidas: 0 };
  const r = avancar(FLUXO_IR, e, '1', CTX);
  assert.equal(r.acao.tipo, 'irFluxo');
  assert.equal(r.acao.fluxo, 'Menu Financeiro');
});

test('validarFluxo: irfluxo válido com nome; sem nome nem id falha', () => {
  assert.deepEqual(validarFluxo(FLUXO_IR), []);
  const ruim = JSON.parse(JSON.stringify(FLUXO_IR));
  delete ruim.nos[1].fluxo;
  assert.ok(validarFluxo(ruim).some((e) => /fluxo de destino/.test(e)));
});

test('validarFluxo: consulta válida passa; sem SELECT ou com ";" falha', () => {
  assert.deepEqual(validarFluxo(FLUXO_CONSULTA), []);
  const ruim = JSON.parse(JSON.stringify(FLUXO_CONSULTA));
  ruim.nos[1].sql = 'DELETE FROM X';
  assert.ok(validarFluxo(ruim).some((e) => /SELECT/.test(e)));
  ruim.nos[1].sql = 'SELECT 1 FROM DUAL; DROP TABLE X';
  assert.ok(validarFluxo(ruim).some((e) => /";"/.test(e)));
});

test('validarFluxo: detecta referência quebrada, inalcançável e menu vazio', () => {
  const ruim = {
    config: { inicio: 'a' },
    nos: [
      { id: 'a', tipo: 'menu', texto: 'x', opcoes: [{ valor: '1', proximo: 'nao_existe' }] },
      { id: 'orfao', tipo: 'mensagem', texto: 'y', proximo: 'a' },
      { id: 'vazio', tipo: 'menu', texto: 'z', opcoes: [] },
    ],
  };
  const erros = validarFluxo(ruim);
  assert.ok(erros.some((e) => /nao_existe/.test(e)));
  assert.ok(erros.some((e) => /orfao.*nunca é alcançado/.test(e)));
  assert.ok(erros.some((e) => /vazio.*sem opções/.test(e)));
});
