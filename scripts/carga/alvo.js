// scripts/carga/alvo.js — Resolve e VALIDA o alvo da carga (FIL-110).
//
// Este arquivo existe por um motivo só: impedir que um teste de carga acerte
// PRODUÇÃO. `api.olumechat.com.br` está no ar atendendo cliente real, e um
// erro de digitação (`api-staging` → `api`) transforma "medir o limite" em
// "derrubar o produto". A guarda é por LISTA DE BLOQUEIO explícita e falha
// fechada: host desconhecido só passa com --eu-sei-o-que-estou-fazendo, e
// nunca aceita os hosts de produção nem com a flag.
//
// A lista mora aqui, no código versionado, e não numa variável de ambiente:
// variável some, o código fica.
'use strict';

/** Hosts que NUNCA podem receber carga — nem com flag de escape. */
const PRODUCAO = Object.freeze([
  'api.olumechat.com.br',
  'olumechat.com.br',
  'www.olumechat.com.br',
]);

/** Hosts esperados para carga. Fora daqui exige confirmação explícita. */
const PERMITIDOS = Object.freeze([
  'api-staging.olumechat.com.br',
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

class AlvoRecusado extends Error {}

/**
 * @param {string} baseUrl  ex.: https://api-staging.olumechat.com.br
 * @param {{ forcar?: boolean }} opcoes
 * @returns {URL}
 */
function resolverAlvo(baseUrl, { forcar = false } = {}) {
  if (!baseUrl) {
    throw new AlvoRecusado('Informe --base-url (ex.: http://localhost:3001)');
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AlvoRecusado(`--base-url inválida: ${baseUrl}`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new AlvoRecusado(`Protocolo não suportado: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  if (PRODUCAO.includes(host)) {
    throw new AlvoRecusado(
      `RECUSADO: ${host} é PRODUÇÃO. Teste de carga contra produção não é ` +
      'permitido por este harness — nem com flag. Use api-staging.olumechat.com.br.'
    );
  }
  if (!PERMITIDOS.includes(host) && !forcar) {
    throw new AlvoRecusado(
      `Host "${host}" não está na lista de alvos conhecidos ` +
      `(${PERMITIDOS.join(', ')}). Se é intencional, repita com ` +
      '--eu-sei-o-que-estou-fazendo.'
    );
  }
  return url;
}

/**
 * Prefixo de caminho do alvo, sem barra final.
 *
 * Não dá para "normalizar" isso dentro do próprio URL: atribuir `''` a
 * `url.pathname` volta a `'/'` sozinho, e aí `pathname + '/health'` vira
 * `'//health'` — que o WHATWG lê como URL protocolo-relativa e transforma
 * `health` em NOME DE HOST. O sintoma era `getaddrinfo ENOTFOUND health`.
 */
const caminhoBase = (alvo) => alvo.pathname.replace(/\/+$/, '');

/** Monta a URL absoluta de uma rota a partir do alvo. */
const urlDe = (alvo, caminho) => new URL(`${alvo.origin}${caminhoBase(alvo)}${caminho}`);

module.exports = { resolverAlvo, AlvoRecusado, caminhoBase, urlDe, PRODUCAO, PERMITIDOS };
