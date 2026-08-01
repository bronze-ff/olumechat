// scripts/carga/ambiente.js — Carrega server/.env sem depender do cwd (FIL-110).
//
// `require('dotenv')` daqui não resolveria (a dependência vive em
// server/node_modules) e `dotenv.config()` procura o `.env` a partir do
// DIRETÓRIO DE TRABALHO — rodar o harness de outra pasta carregaria nada e o
// comando iria ao banco errado (ou a banco nenhum) sem avisar.
//
// Variável já presente no processo NÃO é sobrescrita: é assim que se aponta o
// harness para staging (`DATABASE_URL=... node scripts/carga/executar.js …`)
// sem editar arquivo de segredo.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_PADRAO = path.join(__dirname, '..', '..', 'server', '.env');

function carregarEnv(caminho = CAMINHO_PADRAO) {
  if (!fs.existsSync(caminho)) return { carregado: false, caminho, chaves: 0 };
  let chaves = 0;
  for (const linha of fs.readFileSync(caminho, 'utf8').split(/\r?\n/)) {
    const texto = linha.trim();
    if (!texto || texto.startsWith('#')) continue;
    const igual = texto.indexOf('=');
    if (igual === -1) continue;
    const chave = texto.slice(0, igual).trim();
    if (process.env[chave] !== undefined) continue; // ambiente vence o arquivo
    let valor = texto.slice(igual + 1).trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    process.env[chave] = valor;
    chaves += 1;
  }
  return { carregado: true, caminho, chaves };
}

module.exports = { carregarEnv, CAMINHO_PADRAO };
