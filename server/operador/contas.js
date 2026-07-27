// operador/contas.js — Acesso à tabela `operador` (FIL-70).
//
// Toda leitura/escrita passa por comOperador(): a tabela é fechada para o role
// de tenant (REVOKE + policy USING(false) na migração 005), então este é o
// único caminho que a alcança — e é o caminho que grita "sou cross-tenant".
//
// Não existe rota de auto-cadastro. O primeiro operador nasce por
// `npm run criar-operador` (scripts/criar-operador.js), rodado por quem já tem
// acesso ao banco.
'use strict';

const { comOperador } = require('./db');
const senhas = require('../auth/senha');

const normalizarEmail = (v) => String(v || '').trim().toLowerCase();

/**
 * Linha do operador pelo e-mail (ativo ou não — quem decide o que fazer com
 * `ATIVO` é o login, que precisa responder igual em todos os casos).
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function buscarPorEmail(email) {
  const e = normalizarEmail(email);
  if (!e) return null;
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `SELECT id, email, nome, senha_hash, ativo FROM operador WHERE email = :email`,
      { email: e }
    );
    return r.rows[0] || null;
  });
}

/**
 * Operador ATIVO pelo id — usado a cada requisição pelo middleware. É uma
 * query por request de propósito: desativar um operador precisa ter efeito
 * imediato, não "quando o JWT dele expirar". O volume deste painel é baixo.
 * @param {number} id
 * @returns {Promise<{id:number,email:string,nome:string|null}|null>}
 */
async function buscarAtivoPorId(id) {
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `SELECT id, email, nome FROM operador WHERE id = :id AND ativo = 'S'`,
      { id }
    );
    if (!r.rows.length) return null;
    const o = r.rows[0];
    return { id: Number(o.ID), email: o.EMAIL, nome: o.NOME };
  });
}

/** Carimba o último acesso (dentro da transação do login). */
async function marcarAcesso(conn, id) {
  await conn.execute(`UPDATE operador SET ultimo_acesso_em = now() WHERE id = :id`, { id });
}

/**
 * Cria um operador. Usado pelo script de bootstrap — não há endpoint HTTP.
 * @param {{ email: string, nome?: string, senha: string }} dados
 * @returns {Promise<{ id: number, email: string }>}
 */
async function criar({ email, nome, senha }) {
  const e = normalizarEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('E-mail inválido.');
  const problema = senhas.validarForca(senha);
  if (problema) throw new Error(problema);
  // Hash fora da transação: argon2id custa CPU e não há motivo para segurar
  // uma conexão do pool durante isso (mesmo racional de auth/tokenSenha.js).
  const hash = await senhas.gerarHash(senha);
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `INSERT INTO operador (email, nome, senha_hash) VALUES (:email, :nome, :hash)
       RETURNING id`,
      { email: e, nome: nome ? String(nome).slice(0, 120) : null, hash }
    );
    return { id: Number(r.rows[0].ID), email: e };
  });
}

module.exports = { buscarPorEmail, buscarAtivoPorId, marcarAcesso, criar, normalizarEmail };
