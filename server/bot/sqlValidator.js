// bot/sqlValidator.js — validação SELECT-only reutilizável (motor de fluxo + tools de IA).
'use strict';

/** Devolve array de erros ([] = ok). Mesmas regras do nó 'consulta'.
 *  IMPORTANTE: remove comentários (-- linha, /* bloco *​/) ANTES das checagens —
 *  os .sql curados começam com um cabeçalho comentado, senão o ^SELECT reprovaria
 *  toda query. As checagens de segurança também rodam sobre o texto sem comentário
 *  (não dá pra burlar escondendo DBMS_/UTL_/MC_SENHAS num comentário). */
function validarSQL(sqlRaw) {
  const sql = String(sqlRaw || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  const erros = [];
  if (!/^select\s/i.test(sql)) erros.push('O SQL deve começar com SELECT.');
  // Sobre o texto SEM comentário: rejeita qualquer ";" (bloqueia múltiplos
  // statements). Um ";" que só existisse dentro de um comentário não conta.
  if (sql.includes(';')) erros.push('O SQL não pode conter ";".');
  if (/\bMC_SENHAS\b/i.test(sql)) erros.push('Tabela protegida não permitida.');
  if (/\bDBMS_|\bUTL_|\bEXECUTE\s+IMMEDIATE\b/i.test(sql)) erros.push('Pacote/comando não autorizado.');
  return erros;
}

module.exports = { validarSQL };
