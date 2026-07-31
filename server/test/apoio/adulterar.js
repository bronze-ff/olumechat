// server/test/apoio/adulterar.js — adulteração de blob cifrado para testes.
//
// FIL-111: os testes de AES-GCM "adulteravam" o blob trocando os dois últimos
// caracteres hex por um valor FIXO (`${ct.slice(0, -2)}00`). Quando o byte já
// era aquele valor, o blob adulterado saía IDÊNTICO ao original: a decifragem
// funcionava, nada era lançado e o `assert.throws` falhava. Como o ciphertext
// é aleatório a cada execução (IV aleatório), a chance era de 1 em 256 POR
// asserção — e eram três. Foi assim que a `main` ficou vermelha no `3c01847`,
// um merge só de documentação, bloqueando a publicação da imagem `sha-3c01847`
// no GHCR (FIL-105).
//
// A regra deste módulo: a adulteração é RELATIVA ao valor atual (XOR 0xFF),
// nunca um valor fixo — então o byte muda SEMPRE, para qualquer entrada. Todo
// teste que precise corromper um blob deve usar estas funções em vez de
// reescrever a manipulação de hex à mão; foi a cópia do trecho errado que
// espalhou o defeito por três arquivos.
'use strict';

/**
 * Devolve `hex` com o ÚLTIMO byte invertido bit a bit. Garantidamente diferente
 * da entrada — inclusive quando o byte é `00` ou `ff`.
 */
function adulterarHex(hex) {
  if (typeof hex !== 'string' || hex.length < 2 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`adulterarHex: esperava hex não-vazio de tamanho par, recebi ${JSON.stringify(hex)}`);
  }
  const ultimo = parseInt(hex.slice(-2), 16);
  return hex.slice(0, -2) + (ultimo ^ 0xff).toString(16).padStart(2, '0');
}

function partesDe(blob) {
  const partes = String(blob).split(':');
  if (partes.length !== 3 || partes.some((p) => !p)) {
    throw new Error(`blob no formato iv:tag:ct era esperado, recebi ${JSON.stringify(blob)}`);
  }
  return partes;
}

/** Corrompe o CIPHERTEXT do blob `iv:tag:ct` — a authTag deixa de fechar. */
function adulterarCipher(blob) {
  const [iv, tag, ct] = partesDe(blob);
  return `${iv}:${tag}:${adulterarHex(ct)}`;
}

/** Corrompe a AUTHTAG do blob `iv:tag:ct` — a verificação de integridade falha. */
function adulterarTag(blob) {
  const [iv, tag, ct] = partesDe(blob);
  return `${iv}:${adulterarHex(tag)}:${ct}`;
}

module.exports = { adulterarHex, adulterarCipher, adulterarTag };
