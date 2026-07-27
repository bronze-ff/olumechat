// utils/horario.js — Horário de funcionamento (config) → "está fora de horário?".
//
// Config (MC_ZAP_CONFIG):
//   fora_horario_ativo   'S'|'N'  — liga/desliga o recurso
//   horario_atendimento  JSON     — por dia da semana:
//     { "dom": null, "seg": {"inicio":"08:00","fim":"18:00"}, ... }
//     dia = null (ou sem início/fim) → não trabalha nesse dia (= fora).
//
// Função PURA: recebe o objeto de config e um Date; sem I/O — fácil de testar.
'use strict';

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab']; // getDay() 0..6

/** Converte "HH:MM" em minutos do dia (ou null se inválido). */
function minutos(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Está FORA do horário de atendimento no instante `quando`?
 * - recurso desligado → sempre false (nunca avisa).
 * - dia desligado / config inválida do dia → true (fora).
 * - fora da janela [início, fim) → true.
 * @param {object} cfg  objeto de config (lerConfig)
 * @param {Date}   quando  instante a avaliar (hora local do servidor)
 */
function foraDeHorario(cfg, quando) {
  if (String((cfg && cfg.fora_horario_ativo) || 'N') !== 'S') return false;
  let horario;
  try { horario = JSON.parse((cfg && cfg.horario_atendimento) || '{}'); } catch { return false; }
  const dia = horario[DIAS[quando.getDay()]];
  if (!dia || !dia.inicio || !dia.fim) return true; // não trabalha nesse dia
  const ini = minutos(dia.inicio);
  const fim = minutos(dia.fim);
  if (ini == null || fim == null) return true; // config quebrada → trata como fora
  const agora = quando.getHours() * 60 + quando.getMinutes();
  return agora < ini || agora >= fim;
}

module.exports = { foraDeHorario, _minutos: minutos };
