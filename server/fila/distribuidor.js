// fila/distribuidor.js — Distribuição automática de conversas (least-loaded).
//
// In-process, sem Redis: uma CADEIA DE PROMISES por departamento serializa as
// atribuições (mutex), eliminando corrida dentro do processo. Contra ações
// concorrentes de fora do fluxo (ex.: supervisor atribuindo na mão), o cinto
// de segurança é o UPDATE condicionado a fila_status='aguardando' — se
// rowsAffected=0, alguém levou antes e a rodada re-tenta com a próxima.
//
// Algoritmo: conversa mais antiga da fila -> atendente online (não pausado) do
// depto com MENOS conversas em atendimento; empate -> há mais tempo sem receber
// (lastAssignedAt) = round-robin de fato. Ninguém online -> fica 'aguardando'
// (re-disparado quando alguém ficar online — presence.setAoFicarOnline).
//
// MULTI-TENANT: `atribuir(departamentoId)` mantém a assinatura de sempre —
// conversas.js, webhook e bot chamam por aí sem saber de tenant. O tenantId é
// resolvido AQUI a partir do departamentoId (globalmente único — toda tabela
// do schema usa IDENTITY de coluna única, não composta), com uma consulta
// direta fora de comTenant() (mesmo raciocínio da resolução de tenant por
// phone_number_id no webhook: um identificador global aponta para UM tenant
// só). A partir daí a query de negócio roda dentro de comTenant(tenantId,
// ...), onde a RLS já isola tudo — sem precisar repetir tenant_id nos WHERE
// (mesmo padrão do exemplo canônico em db/pool.js).
'use strict';

const db = require('../db/pool');
const presence = require('../realtime/presence');
const { publish } = require('../realtime/hub');

const cadeias = new Map(); // departamentoId -> Promise (fila de execução)

/** Descobre a qual tenant um departamento pertence (fora de comTenant — é
    justamente o dado que falta para saber qual tenant usar). */
async function tenantDoDepartamento(departamentoId) {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT tenant_id FROM departamento WHERE id = :id`, { id: departamentoId });
    const rows = (r && r.rows) || [];
    return rows.length ? rows[0].TENANT_ID : null;
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

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
  // Checagem em memória PRIMEIRO: ninguém online → nem toca no banco (mesma
  // garantia que webhook/bot já esperam nos testes deles).
  if (!presence.onlineDoDepto(departamentoId).length) return;

  const tenantId = await tenantDoDepartamento(departamentoId);
  if (!tenantId) return; // departamento inexistente/removido

  // Defesa em profundidade: só considera candidatos do MESMO tenant do
  // departamento (departamentoId já é por si só escopado a um tenant via FK,
  // mas o filtro explícito não depende só disso).
  const candidatos = presence.onlineDoDepto(departamentoId, tenantId);
  if (!candidatos.length) return;

  // Acesso por NÚMERO: quais números os candidatos online conseguem atender?
  // Se ALGUÉM é irrestrito (sem números cadastrados), todos os números valem.
  const irrestrito = candidatos.some((id) => presence.numerosDe(id).length === 0);
  const numerosServiveis = irrestrito
    ? null
    : [...new Set(candidatos.flatMap((id) => presence.numerosDe(id)))];
  if (!irrestrito && !numerosServiveis.length) return; // candidatos só atendem números que não estão na fila

  const resultado = await db.comTenant(tenantId, async (conn) => {
    // Conversa mais antiga aguardando QUE ALGUÉM consiga atender (evita head-of-line:
    // uma conversa de número sem candidato online não trava as outras da fila).
    const bSel = { d: departamentoId };
    let filtroNum = '';
    if (!irrestrito) {
      const ms = numerosServiveis.map((n, i) => { bSel[`n${i}`] = n; return `:n${i}`; });
      filtroNum = ` AND (c.numero_id IN (${ms.join(',')}) OR c.numero_id IS NULL)`;
    }
    const sel = await conn.execute(
      `SELECT id, numero_id FROM conversa c
        WHERE fila_status = 'aguardando' AND departamento_id = :d${filtroNum}
        ORDER BY fila_entrou_em NULLS LAST, id
        FETCH FIRST 1 ROWS ONLY`,
      bSel
    );
    if (!sel.rows.length) return null;
    const conversaId = sel.rows[0].ID;
    const numeroDaConversa = sel.rows[0].NUMERO_ID;

    // Só os candidatos que atendem o número DESSA conversa concorrem.
    const elegiveis = candidatos.filter((id) => presence.atendeNumero(id, numeroDaConversa));
    if (!elegiveis.length) return null; // defensivo (o filtro acima já garante ≥1)

    // Carga atual de cada candidato.
    // ATENÇÃO: o objeto de binds precisa casar EXATAMENTE com os placeholders
    // do SQL — bind sobrando dá erro na tradução (foi o que quebrou a
    // distribuição em produção, no Oracle original).
    const binds = {};
    const marcadores = elegiveis.map((id, i) => { binds[`a${i}`] = id; return `:a${i}`; });
    const cargasSel = await conn.execute(
      `SELECT atendente_id, COUNT(*) AS qtd FROM conversa
        WHERE fila_status = 'em_atendimento' AND atendente_id IN (${marcadores.join(',')})
        GROUP BY atendente_id`,
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
      `UPDATE conversa
          SET atendente_id = :a, fila_status = 'em_atendimento', atribuida_em = now()
        WHERE id = :id AND fila_status = 'aguardando'`,
      { a: escolhido, id: conversaId }
    );
    if (!upd.rowsAffected) return { status: 'retry' }; // alguém atribuiu antes — re-tenta com a próxima

    await conn.execute(
      `INSERT INTO auditoria (atendente_id, acao, entidade, entidade_id, detalhe)
       VALUES (:a, 'atribuicao_auto', 'conversa', :id, :det)`,
      { a: escolhido, id: conversaId, det: JSON.stringify({ departamentoId }) }
    );

    // Há mais gente esperando? (decide o re-agendamento)
    const resto = await conn.execute(
      `SELECT COUNT(*) AS qtd FROM conversa
        WHERE fila_status = 'aguardando' AND departamento_id = :d`,
      { d: departamentoId }
    );

    return { status: 'ok', conversaId, escolhido, resto: resto.rows[0].QTD };
  });

  if (!resultado) return;
  if (resultado.status === 'retry') {
    atribuir(departamentoId, tentativa + 1);
    return;
  }

  presence.marcarAtribuicao(resultado.escolhido);
  publish({
    tipo: 'atribuicao',
    conversaId: resultado.conversaId,
    atendenteId: resultado.escolhido,
    departamentoId,
    tenantId,
  });

  if (resultado.resto > 0) atribuir(departamentoId); // drena a fila
}

/** Boot do serviço: varre departamentos com conversas aguardando (recuperação).
    Roda ANTES de qualquer cliente reconectar via SSE — ainda não há tenant de
    contexto, então a varredura é entre tenants por natureza (conexão direta,
    fora de comTenant, como a resolução de tenant por phone_number_id no
    webhook). Cada departamento encontrado passa por atribuir(), que resolve
    o tenant dele e segue no caminho normal. */
async function varrerPendentes() {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT DISTINCT departamento_id FROM conversa
        WHERE fila_status = 'aguardando' AND departamento_id IS NOT NULL`
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
function aoFicarOnline(tenantId, atendenteId, deptoIds) {
  for (const d of deptoIds || []) {
    if (debounces.has(d)) continue;
    const t = setTimeout(() => { debounces.delete(d); atribuir(d); }, 2000);
    if (t.unref) t.unref();
    debounces.set(d, t);
  }
}
presence.setAoFicarOnline(aoFicarOnline);

module.exports = { atribuir, varrerPendentes };
