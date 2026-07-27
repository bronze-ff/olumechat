// scripts/backfill-mensagens.js — Reescreve mensagens já gravadas como JSON cru
// (system, reaction, button, interactive, order, request_welcome, unsupported,
// contacts, location) para o texto amigável, usando o MESMO helper do webhook
// (descreverMensagem). NÃO migra número trocado — só corrige o TEXTO exibido.
// Charset-safe: grava via codificar() (Oracle cp1252).
//
// Uso (dentro de server/):
//   node scripts/backfill-mensagens.js            -> prévia (dry-run, não grava)
//   node scripts/backfill-mensagens.js --commit   -> aplica as correções
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/pool');
const { codificar, decodificar } = require('../utils/texto');
const { descreverMensagem } = require('../utils/descreverMensagem');

// 'order' fica DE FORA de propósito: reescrever destruiria o JSON estruturado do
// pedido (produtos/preços) de forma irreversível. (Cobrança não usa catálogo; se um dia
// usar, o pedido antigo fica como está em vez de virar um resumo com perda de dados.)
const TIPOS = ['system', 'button', 'interactive', 'reaction', 'request_welcome', 'unsupported', 'contacts', 'location'];
const commit = process.argv.includes('--commit');

async function main() {
  await db.initPool();
  let conn;
  try {
    conn = await db.getConnection();
    const binds = {};
    const ms = TIPOS.map((t, i) => { binds[`t${i}`] = t; return `:t${i}`; });
    const r = await conn.execute(
      `SELECT ID, TIPO, CONTEUDO FROM MC_ZAP_MENSAGEM
        WHERE DIRECAO = 'in' AND TIPO IN (${ms.join(',')})
          AND (CONTEUDO LIKE '{%' OR CONTEUDO LIKE '[%')
        ORDER BY ID`,
      binds
    );
    console.log(`Candidatos: ${r.rows.length}   (modo: ${commit ? 'COMMIT' : 'prévia/dry-run'})\n`);

    let reescritos = 0, pulados = 0;
    for (const row of r.rows) {
      let dados;
      // CONTEUDO foi gravado via codificar() (emoji vira \u{hex}, inválido p/ JSON).
      // Decodifica primeiro pra recuperar o JSON original e poder parsear.
      try { dados = JSON.parse(decodificar(row.CONTEUDO)); } catch { pulados++; continue; }
      const novo = descreverMensagem(row.TIPO, dados);
      // A idempotência real vem do filtro LIKE '{%'/'[%' do SELECT (depois de reescrito,
      // o conteúdo não casa mais). Aqui só pulamos quando o helper não devolveu nada.
      if (!novo) { pulados++; continue; }
      console.log(`#${row.ID} [${row.TIPO}]  ${String(row.CONTEUDO).slice(0, 60)}  ->  ${novo}`);
      if (commit) {
        await conn.execute(`UPDATE MC_ZAP_MENSAGEM SET CONTEUDO = :c WHERE ID = :id`,
          { c: codificar(novo), id: row.ID });
      }
      reescritos++;
    }
    if (commit) await conn.commit();
    console.log(`\n${commit ? 'Reescritos' : 'Seriam reescritos'}: ${reescritos} · pulados: ${pulados}`);
    if (!commit && reescritos) console.log('Rode de novo com --commit para aplicar.');
  } finally {
    if (conn) await conn.close().catch(() => {});
    await db.closePool().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FALHA:', e.message); process.exit(1); });
