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
//
// ── MULTI-TENANT (FIL-61, porte da fundação FIL-58) ─────────────────────────
// Este worker NÃO roda dentro de uma requisição HTTP — não há "tenant da vez"
// implícito. Cada operação sobre `campanha`/`campanha_item`/`auditoria` roda
// dentro de db.comTenant(tenantId, fn): RLS garante que a transação só enxerga
// (e só grava) linhas do tenant informado.
//
// O tick/varredura em si PRECISA cruzar tenants (é o próprio propósito: achar
// TODA campanha 'enviando' de TODOS os tenants). Isso é feito com uma leitura
// crua (getConnection, sem SET LOCAL ROLE) contra a tabela `campanha` — o
// dono da conexão no Neon tem BYPASSRLS, então essa leitura enxerga todas as
// linhas. É a MESMA leitura cross-tenant que o dispatcher já fazia antes do
// porte (ele sempre varreu "toda campanha enviando"); a diferença é que agora
// também lê TENANT_ID por linha, para que cada campanha seja processada com o
// contexto de tenant correto a partir daqui pra frente. Resolver múltiplas
// instâncias disputando essa mesma varredura é o ticket de escala horizontal
// (FIL-73, lock de liderança) — NÃO é resolvido aqui, mas o ponto de entrada
// do tick fica isolado em `tick()` para aquele ticket só precisar envolvê-la
// num lock, sem reescrever o dispatcher.
'use strict';

const db = require('../db/pool');
const { sendTemplate } = require('../graph/sendTemplate');
const { publish } = require('../realtime/hub');
const { variantes } = require('../utils/telefone');
const { tentar: tentarLock } = require('../workers/leaderLock');
const consumo = require('../consumo/registrar');

const TICK_MS = 4000;        // varre campanhas 'enviando' a cada 4s
const CUSTO_UTILITY_BR = 0.04; // estimativa R$/msg utility (ajustável)

// Erros transitórios da Meta → pausa com backoff (não marca falha do item).
const TRANSITORIOS = new Set([131049, 130429, 131048, 80007, 130472, 368, 131000]);

let timer = null;
const cadeias = new Map(); // campanhaId -> Promise (mutex). ID é sequência global (único entre tenants).

function defaultDeps() {
  return {
    getConnection: () => db.getConnection(),
    comTenant: (tenantId, fn) => db.comTenant(tenantId, fn),
    sendTemplate,
    agora: () => new Date(),
  };
}

/** HH:MM dentro da janela? (suporta janela que não cruza meia-noite). */
function dentroDaJanela(date, ini, fim) {
  const hhmm = date.toTimeString().slice(0, 5);
  return hhmm >= (ini || '00:00') && hhmm <= (fim || '23:59');
}

/** Enfileira uma rodada para a campanha (serializada). */
function acordar(tenantId, campanhaId, deps = defaultDeps()) {
  if (!campanhaId) return Promise.resolve();
  const anterior = cadeias.get(campanhaId) || Promise.resolve();
  const proxima = anterior
    .then(() => processarLote(tenantId, campanhaId, deps))
    .catch((err) => console.error(`[campanha ${campanhaId}] erro no lote:`, err.message));
  cadeias.set(campanhaId, proxima);
  return proxima;
}

/** True se a ÚLTIMA ação de opt do contato (por qualquer variante do telefone)
    for 'optout'. Bloqueia o disparo (LGPD). */
async function temOptout(conn, telefone) {
  const vs = variantes(telefone);
  const binds = {};
  const marks = vs.map((v, i) => { binds['t' + i] = v; return ':t' + i; });
  const r = await conn.execute(
    `SELECT ct.OPTIN, a.ACAO FROM auditoria a
       JOIN contato ct ON ct.ID = a.ENTIDADE_ID
      WHERE a.ENTIDADE = 'contato' AND a.ACAO IN ('optin','optout')
        AND ct.TELEFONE IN (${marks.join(',')})
      ORDER BY a.CRIADO_EM DESC, a.ID DESC FETCH FIRST 1 ROWS ONLY`,
    binds
  );
  return r.rows.length > 0 && (r.rows[0].OPTIN === 'N' || r.rows[0].ACAO === 'optout');
}

/** Pausa a campanha (usa o `conn` já aberto — chamado de dentro de um
    comTenant() em andamento, sem commit próprio). */
async function pausar(conn, tenantId, campanhaId, motivo, retomaEm) {
  await conn.execute(
    `UPDATE campanha SET STATUS = 'pausada', PAUSA_MOTIVO = :m, RETOMA_EM = :r,
            ATUALIZADO_EM = now() WHERE ID = :id AND STATUS = 'enviando'`,
    { m: motivo, r: retomaEm || null, id: campanhaId });
  // tenantId no evento é obrigatório: o hub (realtime/hub.js) ainda é um
  // EventEmitter global sem filtro por tenant — quem filtra do lado de quem
  // assina é outro ticket (api/stream.js), mas o publicador já precisa
  // etiquetar agora, senão não tem como aquele ticket filtrar depois.
  publish({ tipo: 'campanha', tenantId, campanhaId, status: 'pausada', motivo });
}

function proximaJanela(agora, ini) {
  const d = new Date(agora); d.setDate(d.getDate() + 1);
  const [h, m] = String(ini || '08:00').split(':').map(Number);
  d.setHours(h || 8, m || 0, 0, 0);
  return d;
}

function espera(ms) { return new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); if (t.unref) t.unref(); }); }

/** Processa UM item, numa transação própria (comTenant): claim atômico,
    re-checagem de opt-out, envio, atualização de status. Devolve o desfecho:
    'nao-claimed' | 'optout' | 'enviado' | 'falha' | 'pausada-backoff'. */
async function processarItem(tenantId, campanhaId, item, deps) {
  return deps.comTenant(tenantId, async (conn) => {
    // Claim atômico: só processa se ninguém pegou.
    const claim = await conn.execute(
      `UPDATE campanha_item SET STATUS = 'enviando_item', TENTATIVAS = TENTATIVAS + 1
        WHERE ID = :id AND STATUS = 'pendente'`, { id: item.ID });
    if (!claim.rowsAffected) return 'nao-claimed';

    // Re-checa opt-out (pode ter mudado desde o preparar).
    if (await temOptout(conn, item.TELEFONE)) {
      await conn.execute(`UPDATE campanha_item SET STATUS = 'optout' WHERE ID = :id`, { id: item.ID });
      return 'optout';
    }

    const vars = item.VARIAVEIS || [];
    try {
      const resp = await deps.sendTemplate(item.TELEFONE, item.TEMPLATE_NOME, item.LANG || 'pt_BR', vars, item.PHONE_NUMBER_ID || undefined);
      const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
      await conn.execute(
        `UPDATE campanha_item
            SET STATUS = 'enviado', WAMID = :w, ENVIADO_EM = now(), CUSTO = :cst
          WHERE ID = :id`,
        { w: wamid || null, cst: CUSTO_UTILITY_BR, id: item.ID });
      await conn.execute(
        `UPDATE campanha SET ENVIADOS = ENVIADOS + 1, ATUALIZADO_EM = now() WHERE ID = :id`,
        { id: campanhaId });
      // Medição de consumo (FIL-76/FIL-77): achado de review — disparo de
      // campanha não tinha produtor de mensagem_enviada nenhum.
      await consumo.registrar(conn, tenantId, { tipo: 'mensagem_enviada', quantidade: 1, referencia: item.ID });
      return 'enviado';
    } catch (err) {
      const code = err.isGraphError ? Number(err.graphCode) : 0;
      if (TRANSITORIOS.has(code) || !err.isGraphError) {
        // Transitório: devolve o item à fila e pausa a campanha com backoff.
        await conn.execute(`UPDATE campanha_item SET STATUS = 'pendente' WHERE ID = :id`, { id: item.ID });
        await pausar(conn, tenantId, campanhaId, `pausa automática (erro ${code || 'rede'}) — retoma em breve`,
          new Date(deps.agora().getTime() + 5 * 60_000));
        return 'pausada-backoff';
      }
      // Definitivo (template/número): marca falha e segue o lote.
      await conn.execute(
        `UPDATE campanha_item SET STATUS = 'falha', ERRO_CODIGO = :e WHERE ID = :id`,
        { e: String(code || ''), id: item.ID });
      return 'falha';
    }
  });
}

/** Processa UM lote (até RATE_POR_SEG itens). Re-agenda se sobrar trabalho. */
async function processarLote(tenantId, campanhaId, deps) {
  const preparo = await deps.comTenant(tenantId, async (conn) => {
    if (!await tentarLock(conn, 'campanha', tenantId)) return { acao: 'nada' };
    // Estado atual da campanha (+ número de origem).
    const cSel = await conn.execute(
      `SELECT c.STATUS, c.TEMPLATE_NOME, c.LANG, c.RATE_POR_SEG, c.JANELA_INICIO, c.JANELA_FIM,
              c.RETOMA_EM, n.ID AS NUMERO_ID, n.PHONE_NUMBER_ID, n.LIMITE_DIARIO
         FROM campanha c
         LEFT JOIN numero n ON n.ID = c.NUMERO_ID
        WHERE c.ID = :id`,
      { id: campanhaId }
    );
    if (!cSel.rows.length) return { acao: 'nada' };
    const c = cSel.rows[0];
    if (c.STATUS !== 'enviando') return { acao: 'nada' };

    const agora = deps.agora();
    if (c.RETOMA_EM && new Date(c.RETOMA_EM) > agora) return { acao: 'nada' }; // backoff em andamento
    if (!dentroDaJanela(agora, c.JANELA_INICIO, c.JANELA_FIM)) return { acao: 'nada' }; // fora do horário

    // Teto diário de destinatários do número (across campanhas do mesmo tenant).
    let restantesNoDia = Infinity;
    if (c.LIMITE_DIARIO) {
      const usados = await conn.execute(
        `SELECT COUNT(*) AS QTD FROM campanha_item ci
           JOIN campanha cc ON cc.ID = ci.CAMPANHA_ID
          WHERE cc.NUMERO_ID = :num AND ci.ENVIADO_EM >= date_trunc('day', now())`,
        { num: c.NUMERO_ID }
      );
      restantesNoDia = Number(c.LIMITE_DIARIO) - Number(usados.rows[0].QTD);
      if (restantesNoDia <= 0) {
        await pausar(conn, tenantId, campanhaId, 'limite diário do número atingido', proximaJanela(agora, c.JANELA_INICIO));
        return { acao: 'pausada' };
      }
    }

    const rate = Math.max(1, Number(c.RATE_POR_SEG) || 10);
    // Lote = min(rate, restante do dia) — senão um lote pode ultrapassar o teto
    // diário do número em até RATE_POR_SEG-1 envios (risco de bloqueio na Meta).
    const tamanhoLote = Math.max(1, Math.min(rate, restantesNoDia));
    const lote = await conn.execute(
      `SELECT ID, TELEFONE, VARIAVEIS, CONTATO_ID FROM campanha_item
        WHERE CAMPANHA_ID = :cid AND STATUS = 'pendente'
        ORDER BY ID FETCH FIRST :n ROWS ONLY`,
      { cid: campanhaId, n: tamanhoLote }
    );
    if (!lote.rows.length) {
      // Nada pendente → concluída.
      await conn.execute(
        `UPDATE campanha SET STATUS = 'concluida', ATUALIZADO_EM = now()
          WHERE ID = :id AND STATUS = 'enviando'`, { id: campanhaId });
      return { acao: 'concluida' };
    }

    return {
      acao: 'processar', rate,
      itens: lote.rows.map((item) => ({
        ...item, TEMPLATE_NOME: c.TEMPLATE_NOME, LANG: c.LANG, PHONE_NUMBER_ID: c.PHONE_NUMBER_ID,
      })),
    };
  });

  if (preparo.acao === 'nada') return;
  if (preparo.acao === 'pausada') { publish({ tipo: 'campanha', tenantId, campanhaId, status: 'pausada' }); return; }
  if (preparo.acao === 'concluida') { publish({ tipo: 'campanha', tenantId, campanhaId, status: 'concluida' }); return; }

  const { rate, itens } = preparo;
  let pausouBackoff = false;
  for (const item of itens) {
    const desfecho = await processarItem(tenantId, campanhaId, item, deps);
    if (desfecho === 'pausada-backoff') { pausouBackoff = true; break; }
    // Throttle: espaça os envios conforme RATE_POR_SEG.
    await espera(1000 / rate);
  }

  publish({ tipo: 'campanha', tenantId, campanhaId, status: 'enviando' });
  if (!pausouBackoff) acordar(tenantId, campanhaId, deps); // continua drenando
}

/** Tick periódico: acorda toda campanha que está 'enviando' e cuja pausa venceu,
    em QUALQUER tenant ATIVO. Leitura crua (bypassa RLS via role dono da
    conexão) — ver nota multi-tenant no topo do arquivo. Restringe a
    tenant.status = 'ativo': tenant suspenso/encerrado não pode ter mensagem
    (paga) disparada, mesmo que a campanha tenha ficado 'enviando' de antes de
    ser suspenso — mesmo filtro que varrerPendentes() já aplica. */
async function tick(deps = defaultDeps()) {
  let conn;
  try {
    conn = await deps.getConnection();
    const r = await conn.execute(
      `SELECT c.ID, c.TENANT_ID FROM campanha c
         JOIN tenant t ON t.ID = c.TENANT_ID
        WHERE c.STATUS = 'enviando' AND (c.RETOMA_EM IS NULL OR c.RETOMA_EM <= now())
          AND t.STATUS = 'ativo'`
    );
    await Promise.all(r.rows.map((row) => acordar(row.TENANT_ID, row.ID, deps)));
  } catch (err) {
    console.error('[campanha] tick falhou:', err.message);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/** Boot: solta itens presos em 'enviando_item' sem WAMID (crash no meio), em
    QUALQUER tenant. Descobre os tenants ativos numa leitura crua e roda as
    duas atualizações dentro de comTenant() por tenant (ver nota no topo). */
async function varrerPendentes(deps = defaultDeps()) {
  let conn;
  try {
    conn = await deps.getConnection();
    const tenants = await conn.execute(`SELECT ID FROM tenant WHERE STATUS = 'ativo'`);
    for (const t of tenants.rows) {
      await deps.comTenant(t.ID, async (c) => {
        await c.execute(
          `UPDATE campanha_item SET STATUS = 'pendente'
            WHERE STATUS = 'enviando_item' AND WAMID IS NULL`);
        // Campanhas pausadas por backoff cujo tempo já venceu voltam a 'enviando'.
        await c.execute(
          `UPDATE campanha SET STATUS = 'enviando', PAUSA_MOTIVO = NULL
            WHERE STATUS = 'pausada' AND RETOMA_EM IS NOT NULL AND RETOMA_EM <= now()`);
      });
    }
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

module.exports = {
  iniciar, parar, acordar, processarLote, processarItem, varrerPendentes, tick,
  dentroDaJanela, defaultDeps,
};
