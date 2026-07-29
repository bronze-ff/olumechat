// webhook/durabilidade.js — a camada DURÁVEL na frente do processEvent
// (FIL-94, docs/DEPLOY_VPS.md §P0.6).
//
// Antes: o webhook respondia 200 e processava em memória — um restart no
// instante seguinte perdia a mensagem do cliente, sem rastro. Agora:
//
//   1. `receber()` grava o evento bruto (chave idempotente) — só DEPOIS o
//      routes.js responde 200. Falha ao gravar = erro recuperável (a Meta
//      reenvia); reentrega da Meta = duplicado, ACK sem trabalho novo.
//   2. `processar()` reivindica o evento (estado `recebido` → `processando`),
//      roda o pipeline de sempre e fecha em `concluido`/`falhou`.
//   3. `varrer()` devolve ao trilho o que ficou órfão (processo morto no meio,
//      ou tentativa que falhou), com teto de tentativas, E finaliza os
//      ENCALHADOS — os que esgotaram as tentativas sem conclusão (P2-3): sem
//      esse segundo passe eles ficavam fora do retry (que exige
//      `tentativas < max`) e fora da falha definitiva, pendentes para sempre.
//
// ⚠️ ISTO É UMA CAMADA, NÃO UMA REESCRITA. Todas as garantias do
// `processEvent` continuam onde estavam: dedup por WAMID (índice único
// `mensagem (tenant_id, wamid)`), uma transação por change dentro de
// comTenant(), eventos de tempo real pós-commit e IA/bot fire-and-forget. É
// isso que faz o reprocessamento ser seguro: rodar o mesmo payload duas vezes
// não cria mensagem, conversa ou resposta em dobro.
//
// ⚠️ `concluido` SÓ VALE COM OS EFEITOS DESPACHADOS (achado P1-1 da review do
// PR #40). Os efeitos pós-commit (saudação do bot, entrada da IA, fila, SSE)
// são gravados no outbox DENTRO da transação do change (webhook/efeitoStore.js)
// e despachados de lá; a guarda no SQL do `eventoStore::concluir` recusa fechar
// um evento que ainda tem efeito pendente. Antes disso, morrer entre o commit e
// o dispatch deixava o cliente sem resposta automática — e o replay, que pula a
// mensagem já gravada, não reproduzia o efeito.
//
// ⚠️ `varrer()` NÃO tem guarda de reentrância de propósito — quem serializa é
// a reivindicação atômica no banco (ver o cabeçalho do eventoStore). O guarda
// contra tick sobreposto vive no timer (`tick()`), que é onde ele importa.
//
// Ajustes por ambiente (todos opcionais, defaults abaixo):
//   WEBHOOK_RECUPERACAO_INTERVALO_MS · WEBHOOK_ORFAO_MIN · WEBHOOK_MAX_TENTATIVAS
//   WEBHOOK_RECUPERACAO_LOTE · WEBHOOK_RETENCAO_DIAS · WEBHOOK_ATRASO_ALERTA_MS
'use strict';

const store = require('./eventoStore');
const efeitoStore = require('./efeitoStore');
// Referência ao MÓDULO (não à função): é o que permite a suíte trocar o
// processPayload por um dublê, como o resto do repo faz com db.getConnection.
const processEvent = require('./processEvent');

function num(valor, padrao) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

/** Os que viram argumento de `make_interval`/`LIMIT` no SQL têm que ser
    INTEIROS — um '1.5' no .env quebraria a query, não a configuração. */
function inteiro(valor, padrao) {
  return Math.round(num(valor, padrao));
}

/** Lido a cada uso (não no require) para o ambiente/teste poder ajustar. */
function cfg() {
  return {
    intervaloMs: num(process.env.WEBHOOK_RECUPERACAO_INTERVALO_MS, 60_000),
    // Janela de orfandade: um evento só é considerado abandonado depois disto.
    // Não pode ser curta — durante um rolling update a instância antiga ainda
    // está processando eventos legítimos e não pode tê-los "roubados".
    orfaoMin: inteiro(process.env.WEBHOOK_ORFAO_MIN, 2),
    maxTentativas: inteiro(process.env.WEBHOOK_MAX_TENTATIVAS, 5),
    lote: inteiro(process.env.WEBHOOK_RECUPERACAO_LOTE, 50),
    retencaoDias: inteiro(process.env.WEBHOOK_RETENCAO_DIAS, 7),
    atrasoAlertaMs: num(process.env.WEBHOOK_ATRASO_ALERTA_MS, 60_000),
  };
}

// ── Medição (base dos alertas da §9 do plano de deploy) ────────────────────
// Contadores do processo (zeram no restart) + gauges lidos do banco a cada
// tick. `metricas()` é o snapshot; quem quiser exportar isso para fora (Pulso,
// /diagnostico) lê daqui em vez de reinstrumentar o webhook.
const contadores = {
  recebidos: 0,          // eventos NOVOS persistidos
  duplicados: 0,         // reentrega da Meta colapsada pela chave idempotente
  concluidos: 0,
  falhas: 0,             // tentativas que falharam (inclui as que serão retentadas)
  falhasDefinitivas: 0,  // esgotaram as tentativas (ou erro permanente)
  reprocessados: 0,      // reivindicados pela recuperação
  encalhados: 0,         // finalizados por esgotar tentativas sem conclusão
  efeitosDespachados: 0, // efeitos pós-commit que saíram do outbox
  purgados: 0,
  atrasoUltimoMs: 0,
  atrasoMaxMs: 0,
  pendentes: 0,          // gauge: evento persistido sem conclusão
  maisAntigoSeg: 0,      // gauge: idade do pendente mais velho
  falhasPersistidas: 0,  // gauge: linhas em 'falhou'
};

function metricas() { return { ...contadores }; }

function zerarMetricas() {
  for (const k of Object.keys(contadores)) contadores[k] = 0;
}

function registrarAtraso(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  contadores.atrasoUltimoMs = n;
  if (n > contadores.atrasoMaxMs) contadores.atrasoMaxMs = n;
  const { atrasoAlertaMs } = cfg();
  if (n >= atrasoAlertaMs) {
    console.warn(`[webhook] atraso de processamento alto: ${Math.round(n)}ms`);
  }
}

/**
 * Persiste o evento bruto. RELANÇA o erro de propósito: quem chama (routes.js)
 * tem que responder erro recuperável para a Meta reenviar — engolir aqui seria
 * exatamente o bug que este ticket corrige.
 * @returns {Promise<{id: number|null, duplicado: boolean}>}
 */
async function receber(rawBody, payload) {
  const r = await store.persistir({ rawBody, payload });
  if (r.duplicado) {
    contadores.duplicados += 1;
    return r;
  }
  contadores.recebidos += 1;
  return r;
}

/**
 * Caminho inline (logo depois do ACK): reivindica o evento recém-gravado e
 * processa. Se perder a reivindicação, alguém já está com ele — não faz nada.
 * @returns {Promise<boolean>} true = processou e concluiu
 */
async function processar(id, payload) {
  if (!id) return false;
  if (!(await store.reivindicarNovo(id))) return false;
  return executar(id, payload);
}

/** Roda o pipeline de sempre e fecha o estado do evento. O `eventoId` vai para
    o processPayload porque é ele que liga o outbox de efeitos (P1-1). */
async function executar(id, payload) {
  const { maxTentativas } = cfg();
  let resultado;
  try {
    resultado = await processEvent.processPayload(payload, { eventoId: id });
  } catch (err) {
    await registrarFalha(id, err, maxTentativas);
    return false;
  }
  if (resultado && resultado.despachados) contadores.efeitosDespachados += resultado.despachados;
  try {
    const { atrasoMs, concluido } = await store.concluir(id);
    if (!concluido) {
      // A guarda do SQL barrou: sobrou efeito pós-commit sem despachar (ver
      // eventoStore::concluir). O evento continua pendente e a varredura tenta
      // de novo — é justamente o que impede "concluído" de mentir.
      console.error(`[webhook] evento ${id} não concluído: ${(resultado && resultado.pendentes) || '?'} efeito(s) pós-commit ainda pendente(s)`);
      return false;
    }
    contadores.concluidos += 1;
    registrarAtraso(atrasoMs);
    return true;
  } catch (err) {
    // Processou, mas não conseguiu marcar: fica pendente e a varredura roda de
    // novo — seguro porque o pipeline é idempotente (dedup por WAMID + outbox).
    console.error(`[webhook] evento ${id} processado sem conseguir marcar conclusão:`, err.message);
    return false;
  }
}

/** `max = 0` marca falha DEFINITIVA na hora — use para erro permanente
    (payload ilegível), onde retentar não tem como dar outro resultado. */
async function registrarFalha(id, err, max) {
  contadores.falhas += 1;
  let r = { definitivo: false, tentativas: null };
  try {
    r = await store.falhar(id, err, max);
  } catch (e) {
    console.error(`[webhook] evento ${id} falhou e o registro da falha também:`, e.message);
  }
  if (r.definitivo) {
    contadores.falhasDefinitivas += 1;
    console.error(`[webhook] evento ${id} em FALHA DEFINITIVA após ${r.tentativas} tentativa(s): ${err.message}`);
    // Efeito que já COMMITOU é fato do cliente (a mensagem está no inbox dele):
    // tem que sair mesmo com o evento condenado. Sem esta última tentativa, um
    // evento que morreu entre o commit e o dispatch no ÚLTIMO attempt deixaria o
    // cliente sem resposta automática — o mesmo furo P1-1 pela porta dos fundos.
    await despacharEfeitosCommitados(id);
  } else {
    console.error(`[webhook] evento ${id} falhou (tentativa ${r.tentativas}), será reprocessado: ${err.message}`);
  }
}

/** Última tentativa de despachar o que já estava commitado num evento que vai
    terminar em `falhou`. Nunca lança: o evento já está em estado terminal. */
async function despacharEfeitosCommitados(id) {
  try {
    const r = await processEvent.despacharPendentes(id);
    if (r.despachados) {
      contadores.efeitosDespachados += r.despachados;
      console.warn(`[webhook] evento ${id}: ${r.despachados} efeito(s) pós-commit despachado(s) apesar da falha`);
    }
    if (r.pendentes) {
      console.error(`[webhook] evento ${id} terminou com ${r.pendentes} efeito(s) pós-commit NÃO despachado(s) — investigar (a linha fica no banco)`);
    }
  } catch (err) {
    console.error(`[webhook] evento ${id}: efeitos pós-commit não despachados na falha:`, err.message);
  }
}

/**
 * Um passe de recuperação: reprocessa eventos parados, atualiza os gauges e
 * aplica a retenção. Isolada e exportada para a suíte poder rodar um tick
 * determinístico (é o teste do aceite: "matar o processo depois do ACK").
 */
async function varrer() {
  const c = cfg();
  let candidatos = [];
  try {
    candidatos = await store.candidatosOrfaos({
      orfaoMin: c.orfaoMin, maxTentativas: c.maxTentativas, limite: c.lote,
    });
  } catch (err) {
    console.error('[webhook] recuperação: falha ao listar eventos parados:', err.message);
  }

  for (const cand of candidatos) {
    try {
      if (!(await store.reivindicarOrfao(cand.id, c.orfaoMin))) continue; // outro dono pegou
      contadores.reprocessados += 1;
      let payload;
      try {
        payload = JSON.parse(cand.payload);
      } catch (err) {
        await registrarFalha(cand.id, new Error(`payload gravado ilegível: ${err.message}`), 0);
        continue;
      }
      console.warn(`[webhook] reprocessando evento ${cand.id} (tentativa ${cand.tentativas + 1})`);
      await executar(cand.id, payload);
    } catch (err) {
      console.error(`[webhook] recuperação do evento ${cand.id} falhou:`, err.message);
    }
  }

  await finalizarEncalhados(c);
  await atualizarGauges();
  await aplicarRetencao(c.retencaoDias);
}

/**
 * Segundo passe: eventos que esgotaram as tentativas de PROCESSAMENTO e ficaram
 * parados (P2-3). `candidatosOrfaos` só olha `tentativas < max`, então sem este
 * passe um evento em `processando` com `tentativas == max` cujo UPDATE de
 * finalização falhou por um motivo transitório nunca mais seria tocado: nem
 * retry, nem falha definitiva — pendente para sempre no gauge.
 *
 * O UPDATE finaliza (e reclama) primeiro; depois tentamos despachar os efeitos
 * que já estavam COMMITADOS. Ordem proposital: efeito commitado é fato do
 * cliente e merece sair mesmo com o evento condenado, mas nenhum deles pode
 * manter o evento vivo para sempre.
 */
async function finalizarEncalhados(c) {
  let ids = [];
  try {
    ids = await store.finalizarEncalhados({
      orfaoMin: c.orfaoMin, maxTentativas: c.maxTentativas, limite: c.lote,
      motivo: `finalizado pela recuperacao: ${c.maxTentativas} tentativa(s) sem conclusao`,
    });
  } catch (err) {
    console.error('[webhook] recuperação: falha ao finalizar eventos encalhados:', err.message);
    return;
  }
  for (const id of ids) {
    contadores.falhasDefinitivas += 1;
    contadores.encalhados += 1;
    console.error(`[webhook] evento ${id} FINALIZADO como falhou pela recuperação (tentativas esgotadas sem conclusão)`);
    await despacharEfeitosCommitados(id);
  }
}

/** Lê do banco o que os alertas precisam: pendente sem conclusão e falha
    definitiva acumulada. Só loga quando há algo a dizer (o tick é de 60s). */
async function atualizarGauges() {
  try {
    const p = await store.pendentes();
    contadores.pendentes = p.total;
    contadores.maisAntigoSeg = p.maisAntigoSeg;
    contadores.falhasPersistidas = p.falhas;
    if (p.total || p.falhas) {
      console.log('[webhook] medicao ' + JSON.stringify({
        pendentes: p.total, maisAntigoSeg: p.maisAntigoSeg, falhasPersistidas: p.falhas,
        recebidos: contadores.recebidos, duplicados: contadores.duplicados,
        concluidos: contadores.concluidos, falhas: contadores.falhas,
        atrasoMaxMs: Math.round(contadores.atrasoMaxMs),
      }));
    }
  } catch (err) {
    console.error('[webhook] medição de eventos pendentes falhou:', err.message);
  }
}

/** Retenção do log bruto (contém mensagem de cliente — ver eventoStore). Os
    EFEITOS saem primeiro: eles não têm FK para o evento (ver migração 024), e
    apagar o evento antes deixaria efeito órfão. Se morrer no meio, o evento
    continua concluído e o purge do próximo tick termina o serviço. */
async function aplicarRetencao(dias) {
  if (!dias) return;
  try {
    await efeitoStore.purgarDeEventosConcluidos(dias);
  } catch (err) {
    console.error('[webhook] retenção de efeitos falhou:', err.message);
    return; // sem apagar o evento: senão o efeito viraria órfão
  }
  try {
    const apagados = await store.purgarConcluidos(dias);
    if (apagados) contadores.purgados += apagados;
  } catch (err) {
    console.error('[webhook] retenção de eventos falhou:', err.message);
  }
}

let timer = null;
let emAndamento = false;

/** Tick do timer: nunca deixa dois passes do MESMO processo se sobreporem
    (um passe lento não pode empilhar). Instâncias diferentes seguem podendo
    varrer ao mesmo tempo — a reivindicação atômica resolve. */
async function tick() {
  if (emAndamento) return;
  emAndamento = true;
  try {
    await varrer();
  } catch (err) {
    console.error('[webhook] recuperação falhou:', err.message);
  } finally {
    emAndamento = false;
  }
}

function iniciar() {
  if (timer) return;
  // Já no boot: é exatamente o momento em que eventos podem ter ficado órfãos.
  tick().catch(() => {});
  timer = setInterval(tick, cfg().intervaloMs);
  if (timer.unref) timer.unref();
}

function parar() {
  if (timer) { clearInterval(timer); timer = null; }
  emAndamento = false;
}

module.exports = { receber, processar, varrer, tick, iniciar, parar, metricas, zerarMetricas };
