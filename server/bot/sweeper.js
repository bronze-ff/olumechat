// bot/sweeper.js — Timeout de inatividade do bot. A cada 60s procura conversas
// em FILA_STATUS='bot' paradas além do timeoutMin do fluxo e executa a
// acaoTimeout (encerrar/transferir). Estado no banco ⇒ sobrevive a restart.
'use strict';

const db = require('../db/pool');
const runtime = require('./runtime');

const INTERVALO_MS = 60_000;
let timer = null;

async function varrer() {
  let conn;
  try {
    conn = await db.getConnection();
    // Pega o timeout de cada fluxo direto do JSON (volume baixo: poucas conversas em bot).
    const r = await conn.execute(
      `SELECT c.ID,
              NVL(JSON_VALUE(f.DEFINICAO, '$.config.timeoutMin'), 30) AS TIMEOUT_MIN,
              (CAST(SYSTIMESTAMP AS DATE) - CAST(c.BOT_ULTIMA_INTERACAO AS DATE)) * 1440 AS PARADA_MIN
         FROM MC_ZAP_CONVERSA c
         JOIN MC_ZAP_FLUXO f ON f.ID = c.BOT_FLUXO_ID
        WHERE c.FILA_STATUS = 'bot' AND c.BOT_ULTIMA_INTERACAO IS NOT NULL`
    );
    for (const row of r.rows) {
      if (Number(row.PARADA_MIN) >= Number(row.TIMEOUT_MIN)) {
        runtime.expirar(row.ID); // async, isolado
      }
    }
  } catch (err) {
    console.error('[bot] sweeper falhou:', err.message);
  } finally {
    if (conn) await conn.close().catch(() => {});
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
