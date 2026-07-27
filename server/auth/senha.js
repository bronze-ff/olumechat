// auth/senha.js — Hash e conferência de senha (FIL-67).
//
// argon2id, o algoritmo preferido do ticket. Parâmetros conforme a OWASP
// Password Storage Cheat Sheet para argon2id: m=19MiB, t=2, p=1.
//
// REGRAS QUE NÃO SE NEGOCIAM AQUI:
//  • senha NUNCA em texto plano no banco, em log, em resposta HTTP ou em
//    mensagem de erro. Este módulo só devolve hash e booleano;
//  • comparação SENSÍVEL a maiúsculas/minúsculas — o login antigo comparava
//    com UPPER() dos dois lados, o que reduzia o espaço de busca. Nunca
//    normalize a senha (só o e-mail é normalizado, e fora daqui);
//  • `conferirFalso()` existe para o caminho "usuário não encontrado": sem
//    ele, uma resposta instantânea denunciaria que o e-mail não existe, e a
//    resposta 401 uniforme viraria um oráculo de enumeração de contas.
'use strict';

const crypto = require('crypto');
const argon2 = require('argon2');

const OPCOES = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

// Piso de comprimento em vez de regra de composição (a NIST 800-63B recomenda
// justamente isso: comprimento sobre "1 maiúscula, 1 símbolo"). O teto existe
// para não transformar o login num vetor de DoS de CPU.
const MIN = 10;
const MAX = 128;

/**
 * Valida a política de senha. Devolve `null` se ok, ou a MENSAGEM do problema.
 * Nunca inclui a senha na mensagem.
 * @param {unknown} senha
 * @returns {string|null}
 */
function validarForca(senha) {
  if (typeof senha !== 'string') return 'Senha inválida.';
  if (senha.length < MIN) return `A senha precisa ter pelo menos ${MIN} caracteres.`;
  if (senha.length > MAX) return `A senha pode ter no máximo ${MAX} caracteres.`;
  if (!senha.trim()) return 'A senha não pode ser só espaços.';
  return null;
}

/**
 * @param {string} senha
 * @returns {Promise<string>} hash no formato PHC ($argon2id$v=19$m=...$...)
 */
async function gerarHash(senha) {
  if (typeof senha !== 'string' || !senha) throw new Error('gerarHash: senha vazia');
  return argon2.hash(senha, OPCOES);
}

/**
 * Confere a senha contra o hash. NUNCA lança: hash corrompido, vazio ou de
 * outro algoritmo devolve `false` (um throw aqui viraria 500 no login e
 * distinguiria esse usuário dos demais).
 * @param {string|null|undefined} hash
 * @param {string} senha
 * @returns {Promise<boolean>}
 */
async function conferir(hash, senha) {
  if (typeof hash !== 'string' || !hash || typeof senha !== 'string') return false;
  try {
    return await argon2.verify(hash, senha);
  } catch {
    return false;
  }
}

// Hash descartável, criado uma vez por processo sobre bytes aleatórios: não
// existe senha que case com ele. Serve só para gastar o mesmo tempo de CPU do
// caminho feliz.
let hashDescartavel = null;
function obterHashDescartavel() {
  if (!hashDescartavel) hashDescartavel = gerarHash(crypto.randomBytes(32).toString('hex'));
  return hashDescartavel;
}

/**
 * Gasta o tempo de um argon2.verify sem ter usuário para conferir.
 * Sempre resolve `false`.
 * @param {string} senha
 * @returns {Promise<false>}
 */
async function conferirFalso(senha) {
  try {
    await conferir(await obterHashDescartavel(), typeof senha === 'string' ? senha : '');
  } catch { /* nunca propaga: é só equalização de tempo */ }
  return false;
}

module.exports = { gerarHash, conferir, conferirFalso, validarForca, MIN, MAX, OPCOES };
