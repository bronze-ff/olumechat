// server/ia/toolExecutor.js — executa uma tool de IA: lê o .sql curado, valida
// SELECT-only, injeta binds nomeados e devolve TODAS as linhas. O modelo nunca vê SQL.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');
const { validarSQL } = require('../bot/sqlValidator');
const tools = require('./tools');

async function executar(conn, nomeTool, args = {}, opts = {}) {
  const tool = tools.porNome(nomeTool);
  if (!tool) throw new Error(`Tool desconhecida: ${nomeTool}`);
  const base = opts.conhecimentoDir || loadConfig({ requireDb: false }).conhecimentoDir;
  const arq = path.join(base, tool.arquivoSql);
  let sql;
  try { sql = fs.readFileSync(arq, 'utf8'); }
  catch { throw new Error(`Consulta não encontrada em disco: ${tool.arquivoSql} (rode "Atualizar conhecimento")`); }

  const erros = validarSQL(sql);
  if (erros.length) throw new Error(`SQL da tool ${nomeTool} inválido: ${erros.join(' ')}`);

  // Extrai binds do SQL SEM comentários — senão um :placeholder que só aparece
  // num trecho comentado vira bind fantasma e o Oracle rejeita (ORA-01036). O
  // SQL cru (com comentários) é enviado ao Oracle, que ignora os comentários.
  const semComentarios = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const binds = {};
  for (const m of semComentarios.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    const nome = m[1];
    if (!(nome in binds)) binds[nome] = args[nome] !== undefined ? String(args[nome]) : null;
  }
  // maxRows: teto de linhas para não estourar contexto do modelo nem o CLOB do
  // histórico (ex.: inadimplência pode ter centenas de clientes).
  const r = await conn.execute(sql, binds, { maxRows: 100 });
  const linhas = r.rows || [];
  const colunas = linhas.length ? Object.keys(linhas[0]) : [];
  return { colunas, linhas };
}

module.exports = { executar };
