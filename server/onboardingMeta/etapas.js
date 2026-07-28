// onboardingMeta/etapas.js — as 7 etapas fixas do onboarding assistido da
// Meta (FIL-81), na ordem em que o operador normalmente as percorre.
//
// Etapa sem linha em `onboarding_meta_etapa` é 'pendente' por definição — a
// linha só nasce quando o operador mexe pela primeira vez (ver
// api/onboardingMeta.js). Isto evita ter que "semear" as 7 linhas em todo
// tenant novo.
'use strict';

const ETAPAS = Object.freeze([
  { chave: 'conta_criada', titulo: 'Conta Meta Business criada', descricao: 'Conta criada com o e-mail do cliente.' },
  { chave: 'verificacao_empresa', titulo: 'Verificação da empresa', descricao: 'Documentos enviados e Business Verification aprovada.' },
  { chave: 'waba_criada', titulo: 'WABA criada e vinculada', descricao: 'WhatsApp Business Account criada e vinculada à conta.' },
  { chave: 'numero_verificado', titulo: 'Número cadastrado e verificado', descricao: 'Número cadastrado no Cloud API e verificado.' },
  { chave: 'templates_submetidos', titulo: 'Templates iniciais submetidos', descricao: 'Templates de mensagem enviados para aprovação da Meta.' },
  { chave: 'templates_aprovados', titulo: 'Templates aprovados', descricao: 'Templates aprovados pela Meta.' },
  { chave: 'webhook_testado', titulo: 'Webhook conectado e testado', descricao: 'Mensagem de ponta a ponta confirmada pelo webhook.' },
]);

const CHAVES = Object.freeze(ETAPAS.map((e) => e.chave));
const STATUS = Object.freeze(['pendente', 'em_andamento', 'concluida', 'bloqueada']);

/** Última etapa da sequência — concluí-la sugere o início de cobrança (FIL-76, ver PORTE.md §3.2). */
const ULTIMA_ETAPA = CHAVES[CHAVES.length - 1];

module.exports = { ETAPAS, CHAVES, STATUS, ULTIMA_ETAPA };
