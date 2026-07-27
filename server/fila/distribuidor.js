// fila/distribuidor.js — Distribuição automática de conversas (least-loaded).
//
// In-process, sem Redis: uma CADEIA DE PROMISES por departamento serializa as
// atribuições (mutex), eliminando corrida dentro do processo. Contra ações
// concorrentes de fora do fluxo (ex.: supervisor atribuindo na mão), o cinto
// de segurança é o UPDATE condicionado a FILA_STATUS='aguardando' — se
// rowsAffected=0, alguém levou antes e a rodada re-tenta com a próxima.
// (Sem FOR UPDATE: Oracle não aceita FETCH FIRST + FOR UPDATE — ORA-02014.)
//
// Algoritmo: conversa mais antiga da fila -> atendente online (não pausado) do
// depto com MENOS conversas em atendimento; empate -> há mais tempo sem receber
// (lastAssignedAt) = round-robin de fato. Ninguém online -> fica 'aguardando'
// (re-disparado quando alguém ficar online — presence.setAoFicarOnline).
'use strict';

const db = require('../db/pool');
const presence = require('../realtime/presence');
const { publish } = require('../realtime/hub');

const cadeias = new Map(); // departamentoId -> Promise (fila de execução)

/** Agenda uma rodada de atribuição para o departamento (serializada). */
function atribuir(departamentoId, tentativa = 0) {
  if (!departamentoId) return Promise.resolve();
  if (tentativa > 10) return Promise.resolve(); // guarda contra loop patológico
  const anterior = cadeias.get(departamentoId) || Promise.resolve();
  const proxima = anterior.then(() => rodada(departamentoId, tentativa)).catch((err) => {
    console.error(`[fila] erro na distribuição do depto ${departamentoId}:`, err.message);
  });
  cadeias.set(departamentoId, proxima);
  return proxima;
}

/** Uma rodada: tenta atribuir UMA conversa; se conseguiu e há mais, re-agenda. */
async function rodada(departamentoId, tentativa = 0) {
  const candidatos = presence.onlineDoDepto(departamentoId);
  if (!candidatos.length) return; // ninguém online — fica na fila

  let conn;
  try {
    conn = await db.getConnection();

    // Acesso por NÚMERO: quais números os candidatos online conseguem atender?
    // Se ALGUÉM é irrestrito (sem números cadastrados), todos os números valem.
    const irrestrito = candidatos.some((id) => presence.numerosDe(id).length === 0);
    const numerosServiveis = irrestrito
      ? null
      : [...new Set(candidatos.flatMap((id) => presence.numerosDe(id)))];

    // Conversa mais antiga aguardando QUE ALGUÉM consiga atender (evita head-of-line:
    // uma conversa de número sem candidato online não trava as outras da fila).
    const bSel = { d: departamentoId };
    let filtroNum = '';
    if (!irrestrito) {
      if (!numerosServiveis.length) return; // candidatos só atendem números que não estão na fila
      const ms = numerosServiveis.map((n, i) => { bSel[`n${i}`] = n; return `:n${i}`; });
      filtroNum = ` AND (c.NUMERO_ID IN (${ms.join(',')}) OR c.NUMERO_ID IS NULL)`;
    }
    const sel = await conn.execute(
      `SELECT ID, NUMERO_ID FROM MC_ZAP_CONVERSA c
        WHERE FILA_STATUS = 'aguardando' AND DEPARTAMENTO_ID = :d${filtroNum}
        ORDER BY FILA_ENTROU_EM NULLS LAST, ID
        FETCH FIRST 1 ROWS ONLY`,
      bSel
    );
    if (!sel.rows.length) return;
    const conversaId = sel.rows[0].ID;
    const numeroDaConversa = sel.rows[0].NUMERO_ID;

    // Só os candidatos que atendem o número DESSA conversa concorrem.
    const elegiveis = candidatos.filter((id) => presence.atendeNumero(id, numeroDaConversa));
    if (!elegiveis.length) return; // defensivo (o filtro acima já garante ≥1)

    // Carga atual de cada candidato.
    // ATENÇÃO: o objeto de binds precisa casar EXATAMENTE com os placeholders
    // do SQL — bind sobrando dá ORA-01036 (foi o que quebrou a distribuição).
    const binds = {};
    const marcadores = elegiveis.map((id, i) => { binds[`a${i}`] = id; return `:a${i}`; });
    const cargasSel = await conn.execute(
      `SELECT ATENDENTE_ID, COUNT(*) AS QTD FROM MC_ZAP_CONVERSA
        WHERE FILA_STATUS = 'em_atendimento' AND ATENDENTE_ID IN (${marcadores.join(',')})
        GROUP BY ATENDENTE_ID`,
      binds
    );
    const cargas = new Map(cargasSel.rows.map((r) => [r.ATENDENTE_ID, r.QTD]));

    // Menor carga; empate -> menor lastAssignedAt (quem está há mais tempo sem receber).
    let escolhido = null, melhorCarga = Infinity, melhorTs = Infinity;
    for (const id of elegiveis) {
      const carga = cargas.get(id) || 0;
      const ts = presence.lastAssignedAt(id);
      if (carga < melhorCarga || (carga === melhorCarga && ts < melhorTs)) {
        escolhido = id; melhorCarga = carga; melhorTs = ts;
      }
    }

    const upd = await conn.execute(
      `UPDATE MC_ZAP_CONVERSA
          SET ATENDENTE_ID = :a, FILA_STATUS = 'em_atendimento', ATRIBUIDA_EM = SYSTIMESTAMP
        WHERE ID = :id AND FILA_STATUS = 'aguardando'`,
      { a: escolhido, id: conversaId }
    );
    if (!upd.rowsAffected) { // alguém atribuiu antes — re-tenta com a próxima
      await conn.rollback();
      atribuir(departamentoId, tentativa + 1);
      return;
    }

    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:a, 'atribuicao_auto', 'conversa', :id, :det)`,
      { a: escolhido, id: conversaId, det: JSON.stringify({ departamentoId }) }
    );

    // Há mais gente esperando? (decide o re-agendamento ANTES do commit)
    const resto = await conn.execute(
      `SELECT COUNT(*) AS QTD FROM MC_ZAP_CONVERSA
        WHERE FILA_STATUS = 'aguardando' AND DEPARTAMENTO_ID = :d`,
      { d: departamentoId }
    );

    await conn.commit();

    presence.marcarAtribuicao(escolhido);
    publish({ tipo: 'atribuicao', conversaId, atendenteId: escolhido, departamentoId });

    if (resto.rows[0].QTD > 0) atribuir(departamentoId); // drena a fila
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    throw err;
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/** Boot do serviço: varre departamentos com conversas aguardando (recuperação). */
async function varrerPendentes() {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT DISTINCT DEPARTAMENTO_ID FROM MC_ZAP_CONVERSA
        WHERE FILA_STATUS = 'aguardando' AND DEPARTAMENTO_ID IS NOT NULL`
    );
    for (const row of r.rows) atribuir(row.DEPARTAMENTO_ID);
  } catch (err) {
    console.error('[fila] varredura de pendentes falhou:', err.message);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

// Atendente ficou online/saiu de pausa -> tenta distribuir nas filas dele
// (debounce de 2s para não disparar em refresh de página).
const debounces = new Map();
function aoFicarOnline(atendenteId, deptoIds) {
  for (const d of deptoIds || []) {
    if (debounces.has(d)) continue;
    const t = setTimeout(() => { debounces.delete(d); atribuir(d); }, 2000);
    if (t.unref) t.unref();
    debounces.set(d, t);
  }
}
presence.setAoFicarOnline(aoFicarOnline);

module.exports = { atribuir, varrerPendentes };
