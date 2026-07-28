// server/ia/ativacao.js — "este canal está com a IA ativa NESTE instante?".
//
// FIL-84: até aqui `numero.modo === 'ia'` era a resposta inteira. Agora existe
// a REGRA (`numero.ia_regra`): 'sempre' (a IA cobre 24/7) ou 'fora_horario' (a
// IA cobre a madrugada, o humano cobre o dia).
//
// A fonte de horário é o expediente JÁ configurado do tenant — a MESMA config
// que alimenta o aviso de fora-de-horário (utils/horario.js). Zero config nova,
// por decisão da spec. Consequência consciente: `foraDeHorario()` devolve false
// quando `fora_horario_ativo <> 'S'`, então num tenant que nunca configurou o
// expediente a regra 'fora_horario' NUNCA ativa a IA. A tela do canal avisa o
// admin disso; inventar um expediente default aqui seria a IA atendendo em
// horário que ninguém pediu.
//
// PURA (sem I/O): roda no caminho quente do webhook, a cada mensagem recebida.
// Quem lê a config é o chamador (webhook/processEvent.js, com o cache de 60s do
// utils/configCache.js).
'use strict';

const { foraDeHorario } = require('../utils/horario');

/**
 * @param {{modo?: string, iaRegra?: string}} numero linha de `numero`
 * @param {object} cfg    config do tenant (utils/configCache.lerConfig)
 * @param {Date}   quando instante a avaliar
 * @returns {boolean}
 */
function iaAtivaNoInstante(numero, cfg, quando) {
  if (!numero || numero.modo !== 'ia') return false;
  // Linha antiga (migração 021 recém-aplicada) ou valor inesperado ⇒ 'sempre',
  // que é o comportamento que o canal já tinha antes da coluna existir.
  if ((numero.iaRegra || 'sempre') !== 'fora_horario') return true;
  return foraDeHorario(cfg, quando);
}

module.exports = { iaAtivaNoInstante };
