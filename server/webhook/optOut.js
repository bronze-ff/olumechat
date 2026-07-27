// webhook/optOut.js — Opt-out/opt-in automático por palavra-chave (LGPD).
// Quando o cliente manda "PARAR" (ou similar), registramos o opt-out; "VOLTAR"
// reativa. O estado atual fica em MC_ZAP_CONTATO.OPTIN ('S'/'N') e a trilha
// completa em MC_ZAP_AUDITORIA (ACAO='optin'/'optout'). A checagem de cobrança
// (api/conversas.js) lê a ação MAIS RECENTE, então re-opt-in funciona.
'use strict';

// Frases exatas (já normalizadas) que disparam cada ação.
const OPTOUT = ['PARAR', 'SAIR', 'CANCELAR', 'DESCADASTRAR', 'REMOVER', 'STOP', 'NAO PERTURBE'];
const OPTIN = ['VOLTAR', 'RECEBER', 'QUERO RECEBER', 'INICIAR'];

/** Normaliza: maiúsculas, sem acento, só letras/dígitos/espaço, colapsa espaços. */
function normalizar(txt) {
  return String(txt || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classifica um texto como gatilho de 'optout', 'optin' ou null.
 * Só considera mensagens curtas (até 3 palavras) para evitar falso-positivo
 * quando a palavra aparece no meio de uma frase ("não quero parar de comprar").
 */
function classificar(txt) {
  const n = normalizar(txt);
  if (!n || n.split(' ').length > 3) return null;
  if (OPTOUT.includes(n)) return 'optout';
  if (OPTIN.includes(n)) return 'optin';
  return null;
}

/**
 * Persiste a mudança de opt-in/opt-out: atualiza o estado no contato e grava
 * a trilha na auditoria. Não dá commit — quem chama controla a transação.
 */
async function registrarOpt(conn, oracledb, { contatoId, telefone, acao, origem }) {
  if (acao === 'optin') {
    await conn.execute(
      `UPDATE MC_ZAP_CONTATO SET OPTIN = 'S', OPTIN_ORIGEM = :o, OPTIN_EM = SYSTIMESTAMP
        WHERE ID = :id`,
      { o: origem, id: contatoId }
    );
  } else {
    await conn.execute(
      `UPDATE MC_ZAP_CONTATO SET OPTIN = 'N' WHERE ID = :id`,
      { id: contatoId }
    );
  }
  await conn.execute(
    `INSERT INTO MC_ZAP_AUDITORIA (ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
     VALUES (:acao, 'contato', :id, :det)`,
    { acao, id: contatoId, det: JSON.stringify({ origem, telefone }) }
  );
}

module.exports = { normalizar, classificar, registrarOpt };
