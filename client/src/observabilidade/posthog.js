import { CHAVE_POSTHOG, HOST_POSTHOG } from './env';
import { definirUsuarioSentry } from './sentry';
import { limparEvento } from './posthogEvento.js';
import { aplicarIdentidade } from './posthogSessao.js';

const HOST_PADRAO = 'https://eu.i.posthog.com';

let cliente = null;
let iniciado = false;
let idAtual = '';
let geracao = 0;

async function carregar() {
  if (!cliente) {
    const mod = await import('posthog-js');
    cliente = mod.default;
  }
  return cliente;
}

async function entrar(id, geracaoEntrada) {
  const posthog = await carregar();
  if (geracaoEntrada !== geracao) return;
  const host = HOST_POSTHOG || HOST_PADRAO;
  if (!iniciado) {
    posthog.init(CHAVE_POSTHOG, {
      api_host: host,
      person_profiles: 'identified_only',
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      autocapture: { capture_copied_text: false },
      mask_all_text: true,
      mask_all_element_attributes: true,
      mask_personal_data_properties: true,
      custom_personal_data_properties: ['token', 'ticket', 'email', 'phone', 'telefone', 'senha'],
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '*',
        blockSelector: 'img, video, audio',
      },
      persistence: 'localStorage+cookie',
      bootstrap: { distinctID: id, isIdentifiedID: true },
      before_send: limparEvento,
      loaded(ph) {
        if (geracaoEntrada !== geracao) return;
        ph.identify(id);
      },
    });
    iniciado = true;
  }
  if (geracaoEntrada !== geracao) return;
  idAtual = aplicarIdentidade(posthog, idAtual, id);
}

function sair() {
  if (!iniciado || !cliente) {
    idAtual = '';
    return;
  }
  idAtual = aplicarIdentidade(cliente, idAtual, '');
}

function definirSessao(id) {
  definirUsuarioSentry(id || null);
  const atual = ++geracao;
  if (!CHAVE_POSTHOG) return;
  if (!id) {
    sair();
    return;
  }
  if (id === idAtual && iniciado) return;
  entrar(id, atual);
}

export { definirSessao };
