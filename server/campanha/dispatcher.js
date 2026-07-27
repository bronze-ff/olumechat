// campanha/dispatcher.js — Worker in-process do disparo em lote (sem Redis).
//
// Cada campanha 'enviando' é processada em lotes pequenos, respeitando:
//   - RATE_POR_SEG (throttle);
//   - LIMITE_DIARIO de destinatários do número (Meta começa número novo ~250/dia);
//   - janela de horário comercial (JANELA_INICIO..JANELA_FIM);
//   - opt-out re-checado NO disparo (alguém pode mandar PARAR no meio).
// Idempotência: estado 100% no banco + claim atômico por item (UPDATE WHERE
// STATUS='pendente'); item 'enviado' nunca reenvia. No boot, `varrerPendentes`
// solta itens presos em 'enviando_item' sem WAMID (crash no meio do envio).
//
// Padrão de serialização = cadeia de Promises por campanha (igual fila/distribuidor.js).
// A LÓGICA é injetável (deps) para testes sem banco/rede.
'use strict';

const db = require('../db/pool');
const { sendTemplate } = require('../graph/sendTemplate');
const { publish } = require('../realtime/hub');
const { variantes } = require('../utils/telefone');

const TICK_MS = 4000;        // varre campanhas 'enviando' a cada 4s
const CUSTO_UTILITY_BR = 0.04; // estimativa R$/msg utility (ajustável)

// Erros transitórios da Meta → pausa com backoff (não marca falha do item).
const TRANSITORIOS = new Set([131049, 130429, 131048, 80007, 130472, 368, 131000]);

let timer = null;
const cadeias = new Map(); // campanhaId -> Promise (mutex)

function defaultDeps() {
  return { getConnection: () => db.getConnection(), sendTemplate, agora: () => new Date() };
}

/** HH:MM dentro da janela? (suporta janela que não cruza meia-noite). */
function dentroDaJanela(date, ini, fim) {
  const hhmm = date.toTimeString().slice(0, 5);
  return hhmm >= (ini || '00:00') && hhmm <= (fim || '23:59');
}

/** Enfileira uma rodada para a campanha (serializada). */
function acordar(campanhaId, deps = defaultDeps()) {
  if (!campanhaId) return Promise.resolve();
  const anterior = cadeias.get(campanhaId) || Promise.resolve();
  const proxima = anterior
    .then(() => processarLote(campanhaId, deps))
    .catch((err) => console.error(`[campanha ${campanhaId}] erro no lote:`, err.message));
  cadeias.set(campanhaId, proxima);
  return proxima;
}

/** Processa UM lote (até RATE_POR_SEG itens). Re-agenda se sobrar trabalho. */
async function processarLote(campanhaId, deps) {
  let conn;
  try {
    conn = await deps.getConnection();

    // Estado atual da campanha (+ número de origem).
    const cSel = await conn.execute(
      `SELECT c.STATUS, c.TEMPLATE_NOME, c.LANG, c.RATE_POR_SEG, c.JANELA_INICIO, c.JANELA_FIM,
              c.RETOMA_EM, n.ID AS NUMERO_ID, n.PHONE_NUMBER_ID, n.LIMITE_DIARIO
         FROM MC_ZAP_CAMPANHA c
         LEFT JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
        WHERE c.ID = :id`,
      { id: campanhaId }
    );
    if (!cSel.rows.length) return;
    const c = cSel.rows[0];
    if (c.STATUS !== 'enviando') return;

    const agora = deps.agora();
    if (c.RETOMA_EM && new Date(c.RETOMA_EM) > agora) return; // backoff em andamento
    if (!dentroDaJanela(agora, c.JANELA_INICIO, c.JANELA_FIM)) return; // fora do horário

    // Teto diário de destinatários do número (across campanhas).
    let restantesNoDia = Infinity;
    if (c.LIMITE_DIARIO) {
      const usados = await conn.execute(
        `SELECT COUNT(*) AS QTD FROM MC_ZAP_CAMPANHA_ITEM ci
           JOIN MC_ZAP_CAMPANHA cc ON cc.ID = ci.CAMPANHA_ID
          WHERE cc.NUMERO_ID = :num AND ci.ENVIADO_EM >= TRUNC(SYSDATE)`,
        { num: c.NUMERO_ID }
      );
      restantesNoDia = Number(c.LIMITE_DIARIO) - Number(usados.rows[0].QTD);
      if (restantesNoDia <= 0) {
        await pausar(conn, campanhaId, 'limite diário do número atingido', proximaJanela(agora, c.JANELA_INICIO));
        return;
      }
    }

    const rate = Math.max(1, Number(c.RATE_POR_SEG) || 10);
    // Lote = min(rate, restante do dia) — senão um lote pode ultrapassar o teto
    // diário do número em até RATE_POR_SEG-1 envios (risco de bloqueio na Meta).
    const tamanhoLote = Math.max(1, Math.min(rate, restantesNoDia));
    const lote = await conn.execute(
      `SELECT ID, TELEFONE, VARIAVEIS, CONTATO_ID FROM MC_ZAP_CAMPANHA_ITEM
        WHERE CAMPANHA_ID = :cid AND STATUS = 'pendente'
        ORDER BY ID FETCH FIRST :n ROWS ONLY`,
      { cid: campanhaId, n: tamanhoLote }
    );
    if (!lote.rows.length) {
      // Nada pendente → concluída.
      await conn.execute(
        `UPDATE MC_ZAP_CAMPANHA SET STATUS = 'concluida', ATUALIZADO_EM = SYSTIMESTAMP
          WHERE ID = :id AND STATUS = 'enviando'`, { id: campanhaId });
      await conn.commit();
      publish({ tipo: 'campanha', campanhaId, status: 'concluida' });
      return;
    }

    let pausouBackoff = false;
    for (const item of lote.rows) {
      // Claim atômico: só processa se ninguém pegou.
      const claim = await conn.execute(
        `UPDATE MC_ZAP_CAMPANHA_ITEM SET STATUS = 'enviando_item', TENTATIVAS = TENTATIVAS + 1
          WHERE ID = :id AND STATUS = 'pendente'`, { id: item.ID });
      await conn.commit();
      if (!claim.rowsAffected) continue;

      // Re-checa opt-out (pode ter mudado desde o preparar).
      if (await temOptout(conn, item.TELEFONE)) {
        await conn.execute(`UPDATE MC_ZAP_CAMPANHA_ITEM SET STATUS = 'optout' WHERE ID = :id`, { id: item.ID });
        await conn.commit();
        continue;
      }

      const vars = item.VARIAVEIS ? JSON.parse(typeof item.VARIAVEIS === 'string' ? item.VARIAVEIS : await item.VARIAVEIS.getData()) : [];
      try {
        const resp = await deps.sendTemplate(item.TELEFONE, c.TEMPLATE_NOME, c.LANG || 'pt_BR', vars, c.PHONE_NUMBER_ID || undefined);
        const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
        await conn.execute(
          `UPDATE MC_ZAP_CAMPANHA_ITEM
              SET STATUS = 'enviado', WAMID = :w, ENVIADO_EM = SYSTIMESTAMP, CUSTO = :cst
            WHERE ID = :id`,
          { w: wamid || null, cst: CUSTO_UTILITY_BR, id: item.ID });
        await conn.execute(
          `UPDATE MC_ZAP_CAMPANHA SET ENVIADOS = ENVIADOS + 1, ATUALIZADO_EM = SYSTIMESTAMP WHERE ID = :id`,
          { id: campanhaId });
        await conn.commit();
      } catch (err) {
        const code = err.isGraphError ? Number(err.graphCode) : 0;
        if (TRANSITORIOS.has(code) || !err.isGraphError) {
          // Transitório: devolve o item à fila e pausa a campanha com backoff.
          await conn.execute(`UPDATE MC_ZAP_CAMPANHA_ITEM SET STATUS = 'pendente' WHERE ID = :id`, { id: item.ID });
          await pausar(conn, campanhaId, `pausa automática (erro ${code || 'rede'}) — retoma em breve`,
            new Date(agora.getTime() + 5 * 60_000));
          pausouBackoff = true;
          break;
        }
        // Definitivo (template/número): marca falha e segue o lote.
        await conn.execute(
          `UPDATE MC_ZAP_CAMPANHA_ITEM SET STATUS = 'falha', ERRO_CODIGO = :e WHERE ID = :id`,
          { e: String(code || ''), id: item.ID });
        await conn.commit();
      }

      // Throttle: espaça os envios conforme RATE_POR_SEG.
      await espera(1000 / rate);
    }

    publish({ tipo: 'campanha', campanhaId, status: 'enviando' });
    if (!pausouBackoff) acordar(campanhaId, deps); // continua drenando
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    throw err;
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/** True se a ÚLTIMA ação de opt do contato (por qualquer variante do telefone)
    for 'optout'. Bloqueia o disparo (LGPD). */
async function temOptout(conn, telefone) {
  const vs = variantes(telefone);
  const binds = {};
  const marks = vs.map((v, i) => { binds['t' + i] = v; return ':t' + i; });
  const r = await conn.execute(
    `SELECT a.ACAO FROM MC_ZAP_AUDITORIA a
       JOIN MC_ZAP_CONTATO ct ON ct.ID = a.ENTIDADE_ID
      WHERE a.ENTIDADE = 'contato' AND a.ACAO IN ('optin','optout')
        AND ct.TELEFONE IN (${marks.join(',')})
      ORDER BY a.CRIADO_EM DESC, a.ID DESC FETCH FIRST 1 ROWS ONLY`,
    binds
  );
  return r.rows.length > 0 && r.rows[0].ACAO === 'optout';
}

async function pausar(conn, campanhaId, motivo, retomaEm) {
  await conn.execute(
    `UPDATE MC_ZAP_CAMPANHA SET STATUS = 'pausada', PAUSA_MOTIVO = :m, RETOMA_EM = :r,
            ATUALIZADO_EM = SYSTIMESTAMP WHERE ID = :id AND STATUS = 'enviando'`,
    { m: motivo, r: retomaEm || null, id: campanhaId });
  await conn.commit();
  publish({ tipo: 'campanha', campanhaId, status: 'pausada', motivo });
}

function proximaJanela(agora, ini) {
  const d = new Date(agora); d.setDate(d.getDate() + 1);
  const [h, m] = String(ini || '08:00').split(':').map(Number);
  d.setHours(h || 8, m || 0, 0, 0);
  return d;
}

function espera(ms) { return new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); if (t.unref) t.unref(); }); }

/** Tick periódico: acorda toda campanha que está 'enviando' e cuja pausa venceu. */
async function tick() {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT ID FROM MC_ZAP_CAMPANHA
        WHERE STATUS = 'enviando' AND (RETOMA_EM IS NULL OR RETOMA_EM <= SYSTIMESTAMP)`
    );
    for (const row of r.rows) acordar(row.ID);
  } catch (err) {
    console.error('[campanha] tick falhou:', err.message);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/** Boot: solta itens presos em 'enviando_item' sem WAMID (crash no meio). */
async function varrerPendentes() {
  let conn;
  try {
    conn = await db.getConnection();
    await conn.execute(
      `UPDATE MC_ZAP_CAMPANHA_ITEM SET STATUS = 'pendente'
        WHERE STATUS = 'enviando_item' AND WAMID IS NULL`);
    // Campanhas pausadas por backoff cujo tempo já venceu voltam a 'enviando'.
    await conn.execute(
      `UPDATE MC_ZAP_CAMPANHA SET STATUS = 'enviando', PAUSA_MOTIVO = NULL
        WHERE STATUS = 'pausada' AND RETOMA_EM IS NOT NULL AND RETOMA_EM <= SYSTIMESTAMP`);
    await conn.commit();
  } catch (err) {
    console.error('[campanha] varredura de pendentes falhou:', err.message);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

function iniciar() {
  if (timer) return;
  varrerPendentes();
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
}
function parar() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { iniciar, parar, acordar, processarLote, varrerPendentes, dentroDaJanela, defaultDeps };
