// bot/sweeper.js — Timeout de inatividade do bot. A cada 60s procura conversas
// em fila_status='bot' paradas além do timeoutMin do fluxo e executa a
// acaoTimeout (encerrar/transferir). Estado no banco ⇒ sobrevive a restart.
//
// Shared-schema multi-tenant: sem contexto de tenant a RLS devolve ZERO
// linhas (não existe "varredura sem tenant" nas tabelas de dado). Por isso o
// tick varre tenant por tenant, cada um dentro do seu próprio comTenant().
// Isso NÃO é o item de escala do FIL-73 (lock de liderança contra disparo
// duplicado em N instâncias) — é só o que já é preciso para o tick achar
// alguma linha com uma única instância. `varrer()` continua isolada numa
// função nomeada de propósito: é o ponto de entrada onde o lock entra depois.
'use strict';

const db = require('../db/pool');
const runtime = require('./runtime');
const { tentar: tentarLock } = require('../workers/leaderLock');

const INTERVALO_MS = 60_000;
let timer = null;

/** Ids dos tenants ativos. Lê `tenant` com a conexão crua (dono do banco,
    BYPASSRLS) só para enumerar — é o mesmo caso de uso que a policy
    `tenant_operador` da migração 001 prevê para operador/provisionamento.
    Nenhuma outra tabela é tocada por esta conexão; os dados de cada tenant só
    são lidos dentro do comTenant() de varrerTenant(). */
async function tenantsAtivos() {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT id FROM tenant WHERE status = 'ativo'`);
    return r.rows.map((row) => row.ID);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

const TIMEOUT_MIN_PADRAO = 30;

/** `config.timeoutMin` vem de um JSON editado pelo admin — pode faltar, vir
    como texto não numérico ou zero/negativo. Um `(...)::int` na query quebra
    a query INTEIRA na primeira linha malformada (Postgres avalia a expressão
    por linha; erro de cast aborta o SELECT todo, não só aquela linha) — o que
    derrubaria o sweep do tenant inteiro por causa de UM fluxo mal editado.
    Por isso o cast é feito aqui, defensivo, nunca em SQL. */
function timeoutMinDe(definicao) {
  const bruto = definicao && definicao.config ? definicao.config.timeoutMin : undefined;
  const n = Number(bruto);
  return Number.isFinite(n) && n > 0 ? n : TIMEOUT_MIN_PADRAO;
}

/** Verifica os fluxos parados além do timeout para UM tenant e dispara o expirar. */
async function varrerTenant(tenantId) {
  const expirados = await db.comTenant(tenantId, async (conn) => {
    if (!await tentarLock(conn, 'bot', tenantId)) return [];
    const r = await conn.execute(
      `SELECT c.id, f.definicao,
              EXTRACT(EPOCH FROM (now() - c.bot_ultima_interacao)) / 60 AS parada_min
         FROM conversa c
         JOIN fluxo f ON f.id = c.bot_fluxo_id
        WHERE c.fila_status = 'bot' AND c.bot_ultima_interacao IS NOT NULL
          AND c.tenant_id = :tid`,
      { tid: tenantId }
    );
    return r.rows
      .filter((row) => Number(row.PARADA_MIN) >= timeoutMinDe(row.DEFINICAO))
      .map((row) => row.ID);
  });
  for (const id of expirados) runtime.expirar(tenantId, id); // async, isolado
}

/** Um tick do sweeper. */
async function varrer() {
  let tenants;
  try {
    tenants = await tenantsAtivos();
  } catch (err) {
    console.error('[bot] sweeper: falha ao listar tenants:', err.message);
    return;
  }
  for (const tenantId of tenants) {
    try {
      await varrerTenant(tenantId);
    } catch (err) {
      console.error(`[bot] sweeper falhou (tenant ${tenantId}):`, err.message);
    }
  }
}

function iniciar() {
  if (timer) return;
  timer = setInterval(varrer, INTERVALO_MS);
  if (timer.unref) timer.unref();
}

function parar() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { iniciar, parar, varrer };
