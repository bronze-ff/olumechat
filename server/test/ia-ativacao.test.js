'use strict';
// FIL-84 — "este canal está com a IA ativa NESTE instante?".
//
// Função PURA de propósito: a decisão acontece no caminho quente do webhook
// (toda mensagem recebida) e precisa ser testável sem banco nem relógio real.
//
// A fonte de horário é o expediente JÁ configurado do tenant (a mesma config
// que alimenta o aviso de fora-de-horário) — decisão da spec: zero config nova.
const test = require('node:test');
const assert = require('node:assert');
const { iaAtivaNoInstante } = require('../ia/ativacao');

const EXPEDIENTE = {
  fora_horario_ativo: 'S',
  horario_atendimento: JSON.stringify({
    dom: null, seg: { inicio: '08:00', fim: '18:00' }, ter: { inicio: '08:00', fim: '18:00' },
    qua: { inicio: '08:00', fim: '18:00' }, qui: { inicio: '08:00', fim: '18:00' },
    sex: { inicio: '08:00', fim: '18:00' }, sab: null,
  }),
};
// 2026-07-27 é uma SEGUNDA-feira.
const SEGUNDA_10H = new Date(2026, 6, 27, 10, 0, 0);
const SEGUNDA_23H = new Date(2026, 6, 27, 23, 0, 0);

test('canal em modo padrão nunca ativa a IA, qualquer que seja a regra', () => {
  assert.equal(iaAtivaNoInstante({ modo: 'padrao', iaRegra: 'sempre' }, EXPEDIENTE, SEGUNDA_23H), false);
  assert.equal(iaAtivaNoInstante({ modo: 'padrao', iaRegra: 'fora_horario' }, EXPEDIENTE, SEGUNDA_23H), false);
});

test('regra "sempre": IA ativa 24/7, sem olhar o expediente', () => {
  assert.equal(iaAtivaNoInstante({ modo: 'ia', iaRegra: 'sempre' }, EXPEDIENTE, SEGUNDA_10H), true);
  assert.equal(iaAtivaNoInstante({ modo: 'ia', iaRegra: 'sempre' }, {}, SEGUNDA_10H), true);
});

test('regra "fora_horario": dentro do expediente segue o caminho normal; fora, vai para a IA', () => {
  assert.equal(iaAtivaNoInstante({ modo: 'ia', iaRegra: 'fora_horario' }, EXPEDIENTE, SEGUNDA_10H), false);
  assert.equal(iaAtivaNoInstante({ modo: 'ia', iaRegra: 'fora_horario' }, EXPEDIENTE, SEGUNDA_23H), true);
});

test('regra "fora_horario" com expediente DESLIGADO nunca ativa — e isso é consciente', () => {
  // utils/horario.foraDeHorario devolve false quando fora_horario_ativo <> 'S'.
  // Consequência aceita da decisão "zero config nova": sem expediente
  // configurado em Ajustes, o sistema não tem como saber o que é "fora do
  // horário". A tela do canal avisa o admin. Inventar um default (ex.: 8h-18h)
  // seria a IA atendendo em horário que ninguém pediu.
  assert.equal(iaAtivaNoInstante({ modo: 'ia', iaRegra: 'fora_horario' }, { fora_horario_ativo: 'N' }, SEGUNDA_23H), false);
  assert.equal(iaAtivaNoInstante({ modo: 'ia', iaRegra: 'fora_horario' }, {}, SEGUNDA_23H), false);
});

test('iaRegra ausente (linha antiga, migração recém-aplicada) vale como "sempre"', () => {
  assert.equal(iaAtivaNoInstante({ modo: 'ia' }, EXPEDIENTE, SEGUNDA_10H), true);
  assert.equal(iaAtivaNoInstante({ modo: 'ia', iaRegra: null }, EXPEDIENTE, SEGUNDA_10H), true);
});
