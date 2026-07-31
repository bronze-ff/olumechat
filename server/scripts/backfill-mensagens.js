// scripts/backfill-mensagens.js — Reescreve mensagens já gravadas como JSON cru
// (system, reaction, button, interactive, request_welcome, unsupported,
// contacts, location) para o texto amigável, usando o MESMO helper do webhook
// (descreverMensagem). NÃO migra número trocado — só corrige o TEXTO exibido.
//
// Uso (dentro de server/):
//   node scripts/backfill-mensagens.js --tenant=<id>            -> prévia (dry-run)
//   node scripts/backfill-mensagens.js --tenant=<id> --commit   -> aplica as correções
//
// ── POR QUE --tenant É OBRIGATÓRIO (FIL-102) ────────────────────────────────
// Este script é da era Oracle (banco de um cliente só) e continuava abrindo a
// conexão com `db.getConnection()` cru — sem `SET LOCAL ROLE falatta_app` e sem
// `set_config('app.current_tenant_id', ...)`. O usuário do DATABASE_URL é o dono
// do banco no Neon (`neondb_owner`, `rolbypassrls = true`), então SEM a troca de
// papel a RLS de `mensagem` não vale nada: a prévia imprimia conteúdo de
// mensagem de TODAS as empresas no stdout e o `--commit` reescrevia o histórico
// de todas de uma vez. Agora o alvo é declarado na linha de comando e todo o
// trabalho roda dentro de `db.comTenant(tenantId, ...)` — sem alvo, o script
// recusa rodar. Ver o cabeçalho de `db/pool.js` e `operador/db.js`.
//
// O `tenant_id = :tid` explícito no SELECT e no UPDATE é cinto E suspensório de
// propósito: `DB_APP_ROLE=''` desliga a troca de papel (opção documentada no
// pool) e, num script que reescreve histórico de forma irreversível, o filtro no
// SQL continua valendo mesmo se a RLS não estiver protegendo a transação.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/pool');
const { descreverMensagem } = require('../utils/descreverMensagem');

// 'order' fica DE FORA de propósito: reescrever destruiria o JSON estruturado do
// pedido (produtos/preços) de forma irreversível. (Cobrança não usa catálogo; se um dia
// usar, o pedido antigo fica como está em vez de virar um resumo com perda de dados.)
const TIPOS = ['system', 'button', 'interactive', 'reaction', 'request_welcome', 'unsupported', 'contacts', 'location'];

const USO = [
  'uso: node scripts/backfill-mensagens.js --tenant=<id> [--commit]',
  '     --tenant=<id>  empresa alvo (obrigatório — o script nunca varre todas)',
  '     --commit       aplica as correções; sem ele é só prévia (dry-run)',
].join('\n');

/**
 * Lê os argumentos da linha de comando. Sem `--tenant=<id>` válido devolve
 * `{ ok: false }` — quem chama aborta. Não existe alvo implícito.
 * @param {string[]} argv argumentos (sem `node` e sem o caminho do script)
 */
function parseArgs(argv) {
  const commit = argv.includes('--commit');
  const p = argv.find((a) => a.startsWith('--tenant='));
  if (!p) return { ok: false, erro: 'Faltou --tenant=<id>: o alvo do backfill precisa ser declarado.' };
  const bruto = p.slice('--tenant='.length);
  const id = Number(bruto);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, erro: `--tenant inválido: ${JSON.stringify(bruto)} (esperado inteiro positivo).` };
  }
  return { ok: true, tenantId: id, commit };
}

/**
 * Confirma que o tenant existe ANTES de varrer. Dentro de comTenant() a policy
 * `tenant_proprio` só mostra a própria linha, então zero linhas = id que não
 * existe (ou não é o do contexto). Sem esta guarda, um id digitado errado
 * terminaria com "Candidatos: 0" e cara de sucesso.
 * @param {object} conn conexão já dentro de comTenant()
 * @param {number} tenantId
 * @returns {Promise<string>} nome da empresa
 */
async function confirmarTenant(conn, tenantId) {
  const r = await conn.execute('SELECT NOME FROM tenant WHERE ID = :tid', { tid: tenantId });
  if (!r.rows.length) throw new Error(`tenant ${tenantId} não existe`);
  return r.rows[0].NOME;
}

/**
 * Varre e (opcionalmente) reescreve as mensagens do tenant do contexto.
 * Recebe a conexão pronta — quem chama é responsável por abri-la com
 * `comTenant()`. Não commita: o commit é do `comTenant()`.
 * @param {{ conn: object, tenantId: number, commit?: boolean, log?: (s: string) => void }} opts
 * @returns {Promise<{ candidatos: number, reescritos: number, pulados: number }>}
 */
async function backfillMensagens({ conn, tenantId, commit = false, log = console.log }) {
  const binds = { tid: tenantId };
  const ms = TIPOS.map((t, i) => { binds[`t${i}`] = t; return `:t${i}`; });
  const r = await conn.execute(
    `SELECT ID, TIPO, CONTEUDO FROM mensagem
      WHERE TENANT_ID = :tid AND DIRECAO = 'in' AND TIPO IN (${ms.join(',')})
        AND (CONTEUDO LIKE '{%' OR CONTEUDO LIKE '[%')
      ORDER BY ID`,
    binds
  );
  log(`Candidatos: ${r.rows.length}   (modo: ${commit ? 'COMMIT' : 'prévia/dry-run'})\n`);

  let reescritos = 0, pulados = 0;
  for (const row of r.rows) {
    let dados;
    try { dados = JSON.parse(row.CONTEUDO); } catch { pulados++; continue; }
    const novo = descreverMensagem(row.TIPO, dados);
    // A idempotência real vem do filtro LIKE '{%'/'[%' do SELECT (depois de reescrito,
    // o conteúdo não casa mais). Aqui só pulamos quando o helper não devolveu nada.
    if (!novo) { pulados++; continue; }
    log(`#${row.ID} [${row.TIPO}]  ${String(row.CONTEUDO).slice(0, 60)}  ->  ${novo}`);
    if (commit) {
      await conn.execute(
        `UPDATE mensagem SET CONTEUDO = :c WHERE ID = :id AND TENANT_ID = :tid`,
        { c: novo, id: row.ID, tid: tenantId }
      );
    }
    reescritos++;
  }
  log(`\n${commit ? 'Reescritos' : 'Seriam reescritos'}: ${reescritos} · pulados: ${pulados}`);
  if (!commit && reescritos) log('Rode de novo com --commit para aplicar.');
  return { candidatos: r.rows.length, reescritos, pulados };
}

/**
 * Wiring: valida os argumentos e roda tudo dentro de comTenant(). `deps` existe
 * só para o teste injetar um banco de mentira.
 * @returns {Promise<number>} código de saída do processo
 */
async function main(argv, deps = {}) {
  const banco = deps.db || db;
  const log = deps.log || console.log;
  const erro = deps.erro || console.error;

  const args = parseArgs(argv);
  if (!args.ok) { erro(args.erro); erro(USO); return 1; }

  await banco.initPool();
  try {
    await banco.comTenant(args.tenantId, async (conn) => {
      const nome = await confirmarTenant(conn, args.tenantId);
      log(`Empresa: #${args.tenantId} ${nome}`);
      return backfillMensagens({ conn, tenantId: args.tenantId, commit: args.commit, log });
    });
    return 0;
  } finally {
    await banco.closePool().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { console.error('FALHA:', e.message); process.exit(1); });
}

module.exports = { parseArgs, backfillMensagens, confirmarTenant, main, TIPOS };
