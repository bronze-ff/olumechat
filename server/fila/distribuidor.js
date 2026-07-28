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
// ── MULTI-TENANT (FIL-64, porte da fundação FIL-58) ─────────────────────────
// `atribuir(departamentoId)` mantém a assinatura de sempre — conversas.js,
// webhook e bot chamam por aí sem saber de tenant. A query de NEGÓCIO roda
// dentro de comTenant(tenantId, ...), onde a RLS já isola tudo — sem precisar
// repetir tenant_id nos WHERE (mesmo padrão do exemplo canônico em db/pool.js).
//
// O tenantId em si é resolvido em tenantDoDepartamento(), abaixo — e ESSE é um
// caminho privilegiado deliberado, não uma query "normal": ela lê `departamento`
// com getConnection() cru, SEM SET LOCAL ROLE, contando com o dono da conexão
// no Neon ter BYPASSRLS (mesmo raciocínio documentado no cabeçalho de
// campanha/dispatcher.js, FIL-61/PR#6, e na resolução de tenant por
// phone_number_id no webhook — nenhum desses tem "tenant da vez" de uma
// requisição HTTP pra usar). Se DB_APP_ROLE algum dia apontar essa conexão
// para um role SEM bypass, a leitura crua devolve zero linhas por causa da
// RLS — tenantDoDepartamento loga um aviso nesse caso (ver função) em vez de
// falhar em silêncio como "departamento não existe".
'use strict';

const db = require('../db/pool');
const presence = require('../realtime/presence');
const { publish } = require('../realtime/hub');
const { tentar: tentarLock } = require('../workers/leaderLock');
const { sendText } = require('../graph/sendText');
const consumo = require('../consumo/registrar');

const cadeias = new Map(); // departamentoId -> Promise (fila de execução)
const RETRY_LOCK_MS = 50;

/** Descobre a qual tenant um departamento pertence — caminho privilegiado
    (bypass de RLS via role dono da conexão), não uma query de negócio. Ver
    nota MULTI-TENANT no topo do arquivo. */
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

function retryDepoisDoLock(departamentoId, tentativa) {
  const timer = setTimeout(() => atribuir(departamentoId, tentativa + 1), RETRY_LOCK_MS);
  if (timer.unref) timer.unref();
}

/** Uma rodada: tenta atribuir UMA conversa; se conseguiu e há mais, re-agenda. */
async function rodada(departamentoId, tentativa = 0) {
  // Checagem em memória PRIMEIRO: ninguém online → nem toca no banco (mesma
  // garantia que webhook/bot já esperam nos testes deles).
  if (!presence.onlineDoDepto(departamentoId).length) return;

  const tenantId = await tenantDoDepartamento(departamentoId);
  if (!tenantId) {
    // Chegamos aqui com gente online alegando esse departamento (checagem
    // acima) — resolução vazia não é "departamento não existe", é RUÍDO: ou o
    // departamento sumiu entre o connect e agora (raro), ou a leitura crua de
    // tenantDoDepartamento parou de enxergar por causa da RLS (ver cabeçalho
    // do arquivo — DB_APP_ROLE apontando pra um role sem bypass). Não
    // silencia: loga pra alguém investigar em vez de a fila simplesmente
    // parar de distribuir sem explicação.
    console.error(
      `[fila] tenantDoDepartamento(${departamentoId}) não achou tenant com atendente(s) online — ` +
      `depto removido ou bypass de RLS desligado (ver DB_APP_ROLE)`
    );
    return;
  }

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
    if (!await tentarLock(conn, 'fila', tenantId)) return { status: 'retry-lock' };
    // Conversa mais antiga aguardando QUE ALGUÉM consiga atender (evita head-of-line:
    // uma conversa de número sem candidato online não trava as outras da fila).
    const bSel = { d: departamentoId };
    let filtroNum = '';
    if (!irrestrito) {
      const ms = numerosServiveis.map((n, i) => { bSel[`n${i}`] = n; return `:n${i}`; });
      filtroNum = ` AND (c.numero_id IN (${ms.join(',')}) OR c.numero_id IS NULL)`;
    }
    const sel = await conn.execute(
      `SELECT id, numero_id, contato_id,
              (SELECT cad.atendente_id
                 FROM contato_atendente_depto cad
                WHERE cad.contato_id = c.contato_id
                  AND cad.departamento_id = :d)
                AS atendente_preferencial_id,
              (SELECT pref.nome
                 FROM contato_atendente_depto cad
                 JOIN atendente pref ON pref.id = cad.atendente_id
                WHERE cad.contato_id = c.contato_id
                  AND cad.departamento_id = :d) AS atendente_preferencial_nome,
              (SELECT ct.telefone FROM contato ct WHERE ct.id = c.contato_id) AS telefone,
              (SELECT n.phone_number_id FROM numero n WHERE n.id = c.numero_id) AS phone_number_id
         FROM conversa c
        WHERE fila_status = 'aguardando' AND departamento_id = :d${filtroNum}
        ORDER BY fila_entrou_em NULLS LAST, id
        FETCH FIRST 1 ROWS ONLY`,
      bSel
    );
    if (!sel.rows.length) return null;
    const conversaId = sel.rows[0].ID;
    const numeroDaConversa = sel.rows[0].NUMERO_ID;
    const preferencialId = sel.rows[0].ATENDENTE_PREFERENCIAL_ID || null;

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
    let escolhido = preferencialId && elegiveis.includes(preferencialId) ? preferencialId : null;
    if (!escolhido) {
      let melhorCarga = Infinity, melhorTs = Infinity;
      for (const id of elegiveis) {
        const carga = cargas.get(id) || 0;
        const ts = presence.lastAssignedAt(id);
        if (carga < melhorCarga || (carga === melhorCarga && ts < melhorTs)) {
          escolhido = id; melhorCarga = carga; melhorTs = ts;
        }
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
      {
        a: escolhido,
        id: conversaId,
        det: JSON.stringify({
          departamentoId,
          estrategia: escolhido === preferencialId ? 'responsavel_departamento' : 'menor_carga',
          atendentePreferencialId: preferencialId,
          preferencialDisponivel: Boolean(preferencialId && escolhido === preferencialId),
        }),
      }
    );

    // Há mais gente esperando? (decide o re-agendamento)
    const resto = await conn.execute(
      `SELECT COUNT(*) AS qtd FROM conversa
        WHERE fila_status = 'aguardando' AND departamento_id = :d`,
      { d: departamentoId }
    );

    const infoEscolhido = presence.snapshot(tenantId).find((item) => item.atendenteId === escolhido);
    return {
      status: 'ok',
      conversaId,
      contatoId: sel.rows[0].CONTATO_ID,
      numeroId: numeroDaConversa,
      escolhido,
      escolhidoNome: (infoEscolhido && infoEscolhido.nome) || null,
      preferencialId,
      preferencialNome: sel.rows[0].ATENDENTE_PREFERENCIAL_NOME || null,
      avisarIndisponibilidade: Boolean(preferencialId && escolhido !== preferencialId),
      telefone: sel.rows[0].TELEFONE || null,
      phoneNumberId: sel.rows[0].PHONE_NUMBER_ID || null,
      resto: resto.rows[0].QTD,
    };
  });

  if (!resultado) return;
  if (resultado.status === 'retry-lock') {
    retryDepoisDoLock(departamentoId, tentativa);
    return;
  }
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

  // O WhatsApp Cloud API não exibe uma identidade nativa por atendente. Quando
  // o contato tinha uma pessoa de referência indisponível, deixamos explícito
  // quem seguirá com ele e persistimos o aviso no histórico da conversa.
  if (resultado.avisarIndisponibilidade && resultado.telefone) {
    const nomePreferencial = resultado.preferencialNome || 'Seu atendente de referência';
    const nomeSubstituto = resultado.escolhidoNome || 'outro atendente da equipe';
    const aviso = `${nomePreferencial} não está disponível no momento. Para não deixar você esperando, ${nomeSubstituto} seguirá com o atendimento.`;
    try {
      const resp = await sendText(
        resultado.telefone,
        aviso,
        resultado.phoneNumberId || undefined,
        tenantId
      );
      const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
      await db.comTenant(tenantId, async (conn) => {
        await conn.execute(
          `INSERT INTO mensagem
             (conversa_id, contato_id, numero_id, atendente_id, wamid, direcao, tipo, conteudo, origem, status, ts)
           VALUES (:cv, :ct, :num, :atd, :wamid, 'out', 'text', :txt, 'sistema', 'sent', now())`,
          {
            cv: resultado.conversaId,
            ct: resultado.contatoId,
            num: resultado.numeroId,
            atd: resultado.escolhido,
            wamid: wamid || null,
            txt: aviso,
          }
        );
        // A lista de conversas ordena por ultima_msg_em e mostra o preview da
        // última mensagem — sem isto, o aviso aparece no preview com a hora
        // antiga da mensagem anterior, e a conversa some da ordenação certa.
        await conn.execute(
          `UPDATE conversa SET ultima_msg_em = now() WHERE id = :id`,
          { id: resultado.conversaId }
        );
        // Medição de consumo (FIL-76/FIL-77): achado de review — aviso de
        // indisponibilidade não tinha produtor de mensagem_enviada nenhum.
        // Este aviso REALMENTE saiu pelo WhatsApp (chegamos aqui só depois
        // do sendText ter sucesso, ver try acima).
        await consumo.registrar(conn, tenantId, { tipo: 'mensagem_enviada', quantidade: 1, referencia: resultado.conversaId });
      });
      publish({
        tipo: 'mensagem',
        direcao: 'out',
        conversaId: resultado.conversaId,
        contatoId: resultado.contatoId,
        atendenteId: resultado.escolhido,
        departamentoId,
        tenantId,
      });
    } catch (err) {
      console.error(
        `[fila] não foi possível avisar indisponibilidade na conversa ${resultado.conversaId}:`,
        err.message
      );
    }
  }

  if (resultado.resto > 0) atribuir(departamentoId); // drena a fila
}

/** Boot do serviço: varre departamentos com conversas aguardando (recuperação).
    Roda ANTES de qualquer cliente reconectar via SSE — ainda não há tenant de
    contexto, então a varredura é entre tenants por natureza. Mesmo caminho
    privilegiado de tenantDoDepartamento (getConnection cru, bypass de RLS via
    role dono da conexão — ver nota MULTI-TENANT no topo do arquivo). Cada
    departamento encontrado passa por atribuir(), que resolve o tenant dele e
    segue no caminho normal (comTenant). */
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
