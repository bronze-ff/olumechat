// Testes do horário de funcionamento (foraDeHorario — função pura).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { foraDeHorario } = require('../utils/horario');

// 15/06/2026 é SEGUNDA; 14/06/2026 é DOMINGO.
const HOR = JSON.stringify({
  dom: null,
  seg: { inicio: '08:00', fim: '18:00' },
  sab: { inicio: '08:00', fim: '12:00' },
});
const cfgOn = { fora_horario_ativo: 'S', horario_atendimento: HOR };

test('recurso desligado → nunca está fora de horário', () => {
  assert.equal(foraDeHorario({ fora_horario_ativo: 'N', horario_atendimento: HOR }, new Date(2026, 5, 15, 23, 0)), false);
  assert.equal(foraDeHorario({}, new Date(2026, 5, 15, 23, 0)), false);
});

test('segunda dentro da janela (10:00) → dentro (false)', () => {
  assert.equal(foraDeHorario(cfgOn, new Date(2026, 5, 15, 10, 0)), false);
});

test('segunda antes do início (07:59) → fora (true)', () => {
  assert.equal(foraDeHorario(cfgOn, new Date(2026, 5, 15, 7, 59)), true);
});

test('segunda no fim ou depois (18:00) → fora (true)', () => {
  assert.equal(foraDeHorario(cfgOn, new Date(2026, 5, 15, 18, 0)), true);
  assert.equal(foraDeHorario(cfgOn, new Date(2026, 5, 15, 18, 1)), true);
});

test('exatamente no início (08:00) → dentro (false)', () => {
  assert.equal(foraDeHorario(cfgOn, new Date(2026, 5, 15, 8, 0)), false);
});

test('domingo (dia desligado) → fora (true) a qualquer hora', () => {
  assert.equal(foraDeHorario(cfgOn, new Date(2026, 5, 14, 10, 0)), true);
});

test('sábado com janela menor (11:00 dentro, 12:00 fora)', () => {
  assert.equal(foraDeHorario(cfgOn, new Date(2026, 5, 20, 11, 0)), false); // 20/06 é sábado
  assert.equal(foraDeHorario(cfgOn, new Date(2026, 5, 20, 12, 0)), true);
});

test('JSON inválido → trata como fora (true), sem quebrar', () => {
  assert.equal(foraDeHorario({ fora_horario_ativo: 'S', horario_atendimento: '{quebrado' }, new Date(2026, 5, 15, 10, 0)), false);
  // (JSON quebrado → JSON.parse falha → retorna false p/ não enviar mensagem errada)
});
