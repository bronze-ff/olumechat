import { chaveDescartada, urlOrigemCaminho, redigirString } from './scrub.js';

function limparUrl(valor) {
  if (typeof valor !== 'string') return valor;
  return redigirString(urlOrigemCaminho(valor));
}

const CHAVES_PESSOAIS = new Set(['email', 'nome', 'name', 'phone', 'telefone', '$el_text', '$elements_chain']);

function limparPropriedade(chave, valor) {
  if (chave !== 'properties' && (CHAVES_PESSOAIS.has(chave) || chaveDescartada(chave))) return undefined;
  if (chave === '$set' || chave === '$set_once' || chave === '$initial_person_info') return {};
  if (typeof valor === 'string') {
    if (chave === '$pathname') return valor.split('?')[0].split('#')[0];
    if (/current_url|referrer|pathname|href|^url$/i.test(chave)) return limparUrl(valor);
    return redigirString(valor);
  }
  if (Array.isArray(valor)) {
    return valor.map((item) => limparPropriedade(chave, item)).filter((item) => item !== undefined);
  }
  if (valor && typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      const limpo = limparPropriedade(k, v);
      if (limpo !== undefined) out[k] = limpo;
    }
    return out;
  }
  return valor;
}

export function limparEvento(event) {
  if (!event || typeof event !== 'object') return event;
  const nome = String(event.event || '');
  if (nome === '$snapshot' || nome.startsWith('$session_recording')) return null;
  if (event.properties && typeof event.properties === 'object') {
    event.properties = limparPropriedade('properties', event.properties);
  }
  return event;
}
