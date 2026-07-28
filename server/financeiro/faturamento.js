// financeiro/faturamento.js — geração mensal de fatura + marcação de
// inadimplência (FIL-79). Fecha o ciclo com contrato (operador/contrato.js,
// FIL-76) e consumo (consumo/fechamento.js, FIL-77): NÃO reimplementa nada
// daqueles — só LÊ o que já está lá para montar a fatura do período.
//
// CROSS-TENANT DE PROPÓSITO (comOperador): mesmo padrão de consumo/fechamento.js
// — roda em BYPASSRLS porque processa todos os tenants numa passada só; cada
// query nomeia tenant_id explicitamente. Lock de liderança via advisory lock
// (workers/leaderLock) contra disparo duplicado com mais de uma instância.
//
// ── IDEMPOTÊNCIA (critério de aceite) ───────────────────────────────────────
// `fatura` tem UNIQUE (tenant_id, competencia). gerarFaturaDoTenant faz
// INSERT ... ON CONFLICT DO NOTHING: se a fatura da competência já existe,
// NADA é regravado — nem o total, nem os itens. É isso que garante "fatura
// fechada não muda de valor quando o contrato é alterado depois": os itens só
// nascem uma vez, no INSERT que criou a fatura.
//
// ── SÓ GERA COMPETÊNCIA JÁ ENCERRADA (achado de review do PR #26) ──────────
// A idempotência acima é uma faca de dois gumes: se a rotina gerasse a fatura
// do mês CORRENTE (competência ainda em andamento), o primeiro tick do boot
// já criaria e congelaria essa fatura — e todo consumo registrado dali em
// diante NUNCA entraria nela, porque toda geração seguinte da mesma
// competência bate no ON CONFLICT DO NOTHING. Na prática, quase nada do mês
// seria cobrado. Por isso `gerarFaturaDoTenant` recusa qualquer competência
// >= mês corrente (ver o guard logo no início da função) e o tick() sempre
// chama com `mesAnteriorDe(hoje)` — nunca `anoMesAtual()`. Isso também casa
// com consumo/fechamento.js: quando a fatura do mês anterior é gerada, o
// fechamento de consumo daquele mês já rodou (mesmo tick diário fecha TODAS
// as competências pendentes antes da meia-noite virar o mês), então
// `consumo_mensal` já está completo — nada de gerar em cima de agregado
// parcial. Escolha registrada aqui em vez de "fatura prevista atualizável até
// fechar": manter uma fatura mutável até a emissão duplicaria a lógica de
// idempotência (teria que apagar/reinserir item a cada rodada) só para
// cobrir um mês que ninguém vai cobrar antes de acabar mesmo.
//
// ── QUAL CONTRATO VALE PARA UMA COMPETÊNCIA ─────────────────────────────────
// Não usa "o contrato ativo agora" — usa o que estava vigente NA COMPETÊNCIA
// (inicio_cobranca <= competência <= fim_vigencia OU fim_vigencia NULL). Isso
// importa para fechamento atrasado: gerar a fatura de um mês passado depois
// de uma troca de plano não pode cobrar o plano novo por um mês em que o
// cliente ainda estava no antigo. A mesma consulta resolve sozinha a regra
// "inicio_cobranca no futuro não gera fatura" (nenhum contrato bate o filtro).
//
// ── CUSTO DESCONHECIDO NUNCA VIRA ZERO ──────────────────────────────────────
// consumo_mensal.custo_centavos (FIL-77, migração 016) é NULLABLE de
// propósito: fecharMes() grava NULL para um tenant+competência+tipo se
// QUALQUER evento daquele grupo tinha custo desconhecido (preço ainda não
// cadastrado em preco_provedor) — nunca um COALESCE(...,0) que apagaria a
// diferença entre "grátis" e "não sabemos" pra sempre. Esta rotina não cria
// item de excedente para um tipo com custo NULL (um item de R$0 pareceria
// "sem custo") — em vez disso marca fatura.custo_incerto e lista os tipos
// afetados na observação, para o operador lançar o valor manualmente (item
// avulso) depois de descobrir o preço. Uma competência SEM NENHUM item
// cobrável ainda gera fatura (valor 0, mas sinalizada) se houve consumo com
// custo desconhecido — senão esse consumo ficaria invisível pro operador
// (ver o guard de "nada a cobrar" em gerarFaturaDoTenant). Emitir não é
// bloqueado por custo_incerto — só sinalizado (ver operador/fatura.js
// ::emitirFatura).
//
// ── PARCELA DE IMPLEMENTAÇÃO ────────────────────────────────────────────────
// `implementacao` (FIL-76) não guarda quantas parcelas já foram cobradas — a
// contagem é derivada de fatura_item (origem_tipo='implementacao', origem_id
// = implementacao.id), que é o próprio histórico de faturas já geradas. Cada
// geração cobra UMA parcela a mais até completar numero_parcelas; a última
// parcela absorve o resto da divisão (ver valorDaParcela) para a soma bater
// exatamente o valor total, sem perder centavo de arredondamento. A contagem
// EXCLUI parcela que só existe numa fatura `cancelada` (achado de review do
// PR #26): cancelar a fatura tem que liberar aquela parcela para ser cobrada
// de novo na próxima geração — senão o valor cancelado some do a receber pra
// sempre. operador/implementacao.js::atualizarImplementacao trava
// valor/forma/parcelas depois que a primeira parcela NÃO cancelada é
// faturada, pelo mesmo motivo: mudar o total no meio do parcelamento
// desalinha as parcelas que faltam do que já foi cobrado.
//
// ── ITENS ÚNICOS DO CONTRATO (achado de review do PR #26) ──────────────────
// `contrato_item` com `recorrente = false` (implantação avulsa, desconto
// pontual etc.) antes só entrava na fatura pelo caminho de item RECORRENTE —
// ou seja, nunca entrava em fatura nenhuma. itensDoContrato agora seleciona
// também os itens únicos que ainda não foram cobrados (NOT EXISTS em
// fatura_item por origem_id) — cada um entra em EXATAMENTE uma fatura,
// qualquer que seja a competência gerada primeiro.
//
// ── CICLO DO CONTRATO (achado de review do PR #26) ──────────────────────────
// `ciclo` (mensal/trimestral/anual) antes era só um rótulo: a recorrência
// cheia era somada TODO mês, cobrando um plano anual 12x. deveCobrarRecorrencia
// só inclui o item de recorrência na competência em que o ciclo completa,
// contando os meses desde `inicio_cobranca` — mensal sempre, trimestral a
// cada 3, anual a cada 12. Excedente/item único/parcela de implementação
// continuam podendo aparecer em QUALQUER competência (são cobrança
// independente do ciclo do plano); se nenhum item se aplica na competência,
// gerarFaturaDoTenant não cria fatura nenhuma (nada a cobrar não é fatura de
// R$0, é ausência de fatura).
//
// ── ESCRITA "BEST-EFFORT" POR TENANT ────────────────────────────────────────
// gerarFaturas roda TODOS os tenants na MESMA transação (comOperador). Um
// tenant com dado inconsistente (ex.: itens de contrato somando fatura
// negativa) não pode abortar a transação inteira e derrubar a geração dos
// outros — por isso cada tenant roda isolado em SAVEPOINT (mesmo padrão de
// bot/runtime.js::comSavepoint e api/conversas.js).
'use strict';

const { comOperador } = require('../operador/db');
const auditoria = require('../operador/auditoria');
const { tentarGlobal } = require('../workers/leaderLock');

const DIAS_ATRASO_PADRAO = Number(process.env.FATURA_DIAS_ATRASO) || 5;
const INTERVALO_MS = 24 * 60 * 60 * 1000; // 1x/dia
let timer = null;

function anoMesAtual() { return new Date().toISOString().slice(0, 7); } // 'YYYY-MM' (UTC)

/** Competência anterior à de `data` — é o que o tick sempre fatura (ver
 *  cabeçalho: nunca a competência corrente, ainda em andamento). */
function mesAnteriorDe(data) {
  const d = new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/** Roda `fn` isolado num SAVEPOINT: se falhar, ROLLBACK TO SAVEPOINT recupera
 *  só o que fn tentou fazer, sem abortar a transação inteira (mesmo padrão de
 *  bot/runtime.js::comSavepoint). */
let spSeq = 0;
async function comSavepoint(conn, fn) {
  const nome = `fatura_sp_${spSeq++}`;
  await conn.execute(`SAVEPOINT ${nome}`);
  try {
    const valor = await fn();
    await conn.execute(`RELEASE SAVEPOINT ${nome}`);
    return { ok: true, valor };
  } catch (erro) {
    try {
      await conn.execute(`ROLLBACK TO SAVEPOINT ${nome}`);
      await conn.execute(`RELEASE SAVEPOINT ${nome}`);
    } catch { /* pior caso: a transação segue abortada — o erro original já explica por quê */ }
    return { ok: false, erro };
  }
}

async function tenantsParaFaturar(conn, tenantId) {
  const filtro = tenantId ? 'AND t.id = :tenantId' : '';
  const binds = tenantId ? { tenantId } : {};
  const r = await conn.execute(
    `SELECT t.id FROM tenant t WHERE t.status = 'ativo' ${filtro} ORDER BY t.id`,
    binds
  );
  return r.rows.map((row) => Number(row.ID));
}

/** O contrato vigente NA COMPETÊNCIA informada (não necessariamente o ativo agora — ver cabeçalho). */
async function contratoNaCompetencia(conn, tenantId, competencia) {
  const r = await conn.execute(
    `SELECT id, plano_nome, valor_recorrente_centavos, ciclo, dia_vencimento, inicio_cobranca, fim_vigencia
       FROM contrato
      WHERE tenant_id = :tenantId
        AND to_char(inicio_cobranca, 'YYYY-MM') <= :competencia
        AND (fim_vigencia IS NULL OR to_char(fim_vigencia, 'YYYY-MM') >= :competencia)
      ORDER BY criado_em DESC LIMIT 1`,
    { tenantId, competencia }
  );
  return r.rows[0] || null;
}

/** Itens recorrentes (repetem TODA competência) + itens únicos ainda não
 *  cobrados (recorrente=false, cobrados uma vez só — ver cabeçalho). */
async function itensDoContrato(conn, contratoId) {
  const r = await conn.execute(
    `SELECT id, tipo, descricao, valor_unitario_centavos, quantidade
       FROM contrato_item ci
      WHERE ci.contrato_id = :contratoId
        AND (
          ci.recorrente = true
          OR NOT EXISTS (
            SELECT 1 FROM fatura_item fi
              JOIN fatura f ON f.id = fi.fatura_id
             WHERE fi.origem_tipo = 'contrato_item' AND fi.origem_id = ci.id AND f.status <> 'cancelada'
          )
        )`,
    { contratoId }
  );
  return r.rows;
}

async function excedentesDoPeriodo(conn, tenantId, competencia) {
  const r = await conn.execute(
    `SELECT tipo, quantidade, custo_centavos
       FROM consumo_mensal
      WHERE tenant_id = :tenantId AND ano_mes = :competencia`,
    { tenantId, competencia }
  );
  return r.rows;
}

/** Tipos do período cujo custo_centavos veio NULL — consumo_mensal.custo_centavos
 *  (FIL-77, migração 016) é NULLABLE de propósito: fecharMes() grava NULL
 *  quando QUALQUER evento do grupo tem custo desconhecido (preço ainda não
 *  cadastrado em preco_provedor), em vez de um COALESCE(...,0) que apagaria
 *  a diferença entre "grátis" e "não sabemos" para sempre. Ler o NULL direto
 *  do agregado (em vez de reconsultar consumo_evento) sobrevive à retenção de
 *  90 dias do bruto e já vem por tipo. */
function tiposComCustoDesconhecido(excedentes) {
  return excedentes.filter((row) => row.CUSTO_CENTAVOS === null).map((row) => row.TIPO);
}

async function implementacaoDoTenant(conn, tenantId) {
  const r = await conn.execute(
    `SELECT id, valor_centavos, forma_pagamento, numero_parcelas
       FROM implementacao WHERE tenant_id = :tenantId ORDER BY criado_em DESC, id DESC LIMIT 1`,
    { tenantId }
  );
  return r.rows[0] || null;
}

/** Parcelas já faturadas de UMA implementação — EXCLUI parcela cujo fatura_item
 *  só existe numa fatura `cancelada` (ver cabeçalho): cancelar libera a parcela. */
async function parcelasJaFaturadas(conn, implementacaoId) {
  const r = await conn.execute(
    `SELECT COUNT(*) AS cnt
       FROM fatura_item fi
       JOIN fatura f ON f.id = fi.fatura_id
      WHERE fi.origem_tipo = 'implementacao' AND fi.origem_id = :id AND f.status <> 'cancelada'`,
    { id: implementacaoId }
  );
  return Number((r.rows[0] || {}).CNT || 0);
}

/** Valor da parcela `indice` (1-based) de um total dividido em `numeroParcelas`
 *  — a ÚLTIMA parcela absorve o resto da divisão inteira, então a soma de
 *  todas as parcelas bate EXATAMENTE o valor total (nunca perde centavo). */
function valorDaParcela(valorTotalCentavos, numeroParcelas, indice) {
  const base = Math.floor(valorTotalCentavos / numeroParcelas);
  if (indice < numeroParcelas) return base;
  return valorTotalCentavos - base * (numeroParcelas - 1);
}

function vencimentoDe(competencia, diaVencimento) {
  return `${competencia}-${String(diaVencimento).padStart(2, '0')}`;
}

const PERIODICIDADE_MESES = Object.freeze({ mensal: 1, trimestral: 3, anual: 12 });

/** Quantos meses de calendário separam `inicioCobranca` (date) de `competencia`
 *  ('YYYY-MM'). Negativo se a competência é anterior ao início. */
function mesesEntre(inicioCobranca, competencia) {
  const [anoInicio, mesInicio] = String(inicioCobranca).slice(0, 7).split('-').map(Number);
  const [anoComp, mesComp] = competencia.split('-').map(Number);
  return (anoComp - anoInicio) * 12 + (mesComp - mesInicio);
}

/** true quando a competência é uma virada do ciclo do contrato (mensal:
 *  sempre; trimestral: a cada 3 meses desde inicio_cobranca; anual: a cada
 *  12) — ver cabeçalho sobre o achado de review do PR #26. */
function deveCobrarRecorrencia(inicioCobranca, competencia, ciclo) {
  const periodo = PERIODICIDADE_MESES[ciclo];
  if (!periodo) return false; // ciclo desconhecido — CICLOS já valida na criação do contrato
  const meses = mesesEntre(inicioCobranca, competencia);
  return meses >= 0 && meses % periodo === 0;
}

function itemRecorrencia(contrato) {
  const valor = Number(contrato.VALOR_RECORRENTE_CENTAVOS);
  return {
    tipo: 'recorrencia', descricao: `Recorrência — ${contrato.PLANO_NOME} (${contrato.CICLO})`,
    quantidade: 1, valorUnitarioCentavos: valor, valorTotalCentavos: valor,
    origemTipo: 'contrato', origemId: Number(contrato.ID),
  };
}

function itensDeContrato(rows) {
  return rows.map((row) => {
    const quantidade = Number(row.QUANTIDADE);
    const valorUnitarioCentavos = Number(row.VALOR_UNITARIO_CENTAVOS);
    return {
      tipo: row.TIPO, descricao: row.DESCRICAO, quantidade,
      valorUnitarioCentavos, valorTotalCentavos: quantidade * valorUnitarioCentavos,
      origemTipo: 'contrato_item', origemId: Number(row.ID),
    };
  });
}

/** Uma linha por tipo de consumo com quantidade ou custo CONHECIDO no período
 *  (custo_centavos NULL fica de fora — ver tiposComCustoDesconhecido: um item
 *  de fatura com valor 0 pareceria "sem custo", quando na verdade é "não
 *  sabemos"; o operador vê o tipo na observação da fatura e lança o valor
 *  manualmente como item avulso quando tiver o preço). Quantidade sempre 1
 *  (o total já congela o custo agregado) — evita resto de divisão ao tentar
 *  expressar "preço por unidade" de um tipo com milhares de unidades. */
function itensDeExcedente(rows, competencia) {
  return rows
    .filter((row) => row.CUSTO_CENTAVOS !== null && (Number(row.QUANTIDADE) > 0 || Number(row.CUSTO_CENTAVOS) !== 0))
    .map((row) => {
      const valorTotalCentavos = Math.round(Number(row.CUSTO_CENTAVOS));
      return {
        tipo: 'excedente',
        descricao: `Excedente de ${row.TIPO} — ${Number(row.QUANTIDADE)} unidade(s) (${competencia})`,
        quantidade: 1, valorUnitarioCentavos: valorTotalCentavos, valorTotalCentavos,
        origemTipo: 'consumo_mensal', origemId: null,
      };
    });
}

async function itemDeImplementacao(conn, implementacao) {
  if (!implementacao) return null;
  const valor = Number(implementacao.VALOR_CENTAVOS);
  const implementacaoId = Number(implementacao.ID);
  const jaFaturadas = await parcelasJaFaturadas(conn, implementacaoId);

  if (implementacao.FORMA_PAGAMENTO === 'a_vista') {
    if (jaFaturadas > 0) return null; // já cobrada de uma vez
    return {
      tipo: 'implementacao', descricao: 'Implementação (à vista)',
      quantidade: 1, valorUnitarioCentavos: valor, valorTotalCentavos: valor,
      origemTipo: 'implementacao', origemId: implementacaoId,
    };
  }

  const numeroParcelas = Number(implementacao.NUMERO_PARCELAS);
  if (jaFaturadas >= numeroParcelas) return null; // parcelamento concluído
  const indice = jaFaturadas + 1;
  const valorParcela = valorDaParcela(valor, numeroParcelas, indice);
  return {
    tipo: 'implementacao', descricao: `Implementação — parcela ${indice}/${numeroParcelas}`,
    quantidade: 1, valorUnitarioCentavos: valorParcela, valorTotalCentavos: valorParcela,
    origemTipo: 'implementacao', origemId: implementacaoId,
  };
}

/**
 * Gera (se ainda não existir) a fatura `prevista` de UM tenant para a
 * competência. Devolve null quando não há nada a fazer: competência ainda não
 * encerrada (ver cabeçalho), sem contrato vigente nela (inclui "inicio_cobranca
 * no futuro"), fatura já existe (idempotência), ou nenhum item se aplica
 * (ciclo não vira neste mês e não há excedente/parcela/item único pendente).
 */
async function gerarFaturaDoTenant(conn, tenantId, competencia, operador = null) {
  if (competencia >= anoMesAtual()) return null; // só competência já encerrada — ver cabeçalho

  const contrato = await contratoNaCompetencia(conn, tenantId, competencia);
  if (!contrato) return null;

  const itens = [];
  if (deveCobrarRecorrencia(contrato.INICIO_COBRANCA, competencia, contrato.CICLO)) {
    itens.push(itemRecorrencia(contrato));
  }
  itens.push(...itensDeContrato(await itensDoContrato(conn, Number(contrato.ID))));

  const excedentes = await excedentesDoPeriodo(conn, tenantId, competencia);
  itens.push(...itensDeExcedente(excedentes, competencia));
  const tiposIncertos = tiposComCustoDesconhecido(excedentes);
  const custoIncerto = tiposIncertos.length > 0;

  const itemImplementacao = await itemDeImplementacao(conn, await implementacaoDoTenant(conn, tenantId));
  if (itemImplementacao) itens.push(itemImplementacao);

  // Nada a cobrar E nenhuma incerteza a sinalizar — não gera fatura de R$0.
  // custoIncerto sozinho JUSTIFICA a fatura mesmo com itens=[]: senão o
  // consumo sem preço cadastrado deste tenant fica invisível pro operador
  // (é exatamente o "nunca assumir zero em silêncio" do ticket).
  if (!itens.length && !custoIncerto) return null;

  const valorTotalCentavos = itens.reduce((acc, it) => acc + it.valorTotalCentavos, 0);
  const vencimento = vencimentoDe(competencia, Number(contrato.DIA_VENCIMENTO));
  const observacoes = custoIncerto
    ? `Consumo do período tem custo desconhecido (preço ainda não cadastrado em preco_provedor) para: ${tiposIncertos.join(', ')} — lance o valor manualmente (item avulso) e revise antes de emitir.`
    : null;

  const ins = await conn.execute(
    `INSERT INTO fatura (tenant_id, competencia, vencimento, valor_total_centavos, status, custo_incerto, observacoes)
     VALUES (:tenantId, :competencia, :vencimento, :valorTotalCentavos, 'prevista', :custoIncerto, :observacoes)
     ON CONFLICT (tenant_id, competencia) DO NOTHING
     RETURNING id`,
    { tenantId, competencia, vencimento, valorTotalCentavos, custoIncerto, observacoes }
  );
  if (!ins.rows.length) return null; // já existia — idempotência

  const faturaId = Number(ins.rows[0].ID);
  for (const item of itens) {
    await conn.execute(
      `INSERT INTO fatura_item
         (fatura_id, tipo, descricao, quantidade, valor_unitario_centavos, valor_total_centavos, origem_tipo, origem_id)
       VALUES (:faturaId, :tipo, :descricao, :quantidade, :valorUnitario, :valorTotal, :origemTipo, :origemId)`,
      {
        faturaId, tipo: item.tipo, descricao: item.descricao, quantidade: item.quantidade,
        valorUnitario: item.valorUnitarioCentavos, valorTotal: item.valorTotalCentavos,
        origemTipo: item.origemTipo || null, origemId: item.origemId || null,
      }
    );
  }

  await auditoria.registrar(conn, {
    operador, tenantId, acao: 'fatura_gerada', entidade: 'fatura', entidadeId: faturaId,
    detalhe: { competencia, valorTotalCentavos, custoIncerto, itens: itens.length },
  });

  return { id: faturaId, tenantId, competencia, valorTotalCentavos, custoIncerto };
}

/**
 * Gera a fatura `prevista` de todos os tenants ativos (ou só de `tenantId`,
 * se informado) para `competencia`. IDEMPOTENTE (critério de aceite): rodar
 * duas vezes para a mesma competência não duplica — a segunda passada só
 * encontra ON CONFLICT DO NOTHING em cada tenant. Falha isolada por tenant
 * (SAVEPOINT) não derruba a geração dos demais.
 * @param {object} conn conexão de operador (comOperador) já aberta
 * @param {string} competencia 'YYYY-MM'
 * @param {{ tenantId?: number, operador?: object|null }} [opts] `operador`
 *   identifica quem disparou (rota manual); omitido/null = rotina automática.
 * @returns {Promise<Array<object>>} faturas efetivamente criadas nesta chamada
 */
async function gerarFaturas(conn, competencia, { tenantId, operador = null } = {}) {
  const tenants = await tenantsParaFaturar(conn, tenantId);
  const geradas = [];
  for (const id of tenants) {
    const { ok, valor, erro } = await comSavepoint(conn, () => gerarFaturaDoTenant(conn, id, competencia, operador));
    if (!ok) {
      console.error(`[financeiro] falha ao gerar fatura do tenant ${id} (${competencia}):`, erro.message);
      continue;
    }
    if (valor) geradas.push(valor);
  }
  return geradas;
}

/**
 * Marca `atrasada` toda fatura `emitida` vencida há mais de `diasAtraso` dias.
 * NUNCA suspende o tenant — isso continua ação explícita do operador (ver
 * operador/fatura.js::listarInadimplencia, que só SUGERE).
 * @returns {Promise<number>} quantas faturas foram marcadas nesta passada
 */
async function marcarAtrasadas(conn, diasAtraso = DIAS_ATRASO_PADRAO) {
  const dias = Math.max(0, Math.round(Number(diasAtraso) || 0));
  const r = await conn.execute(
    `UPDATE fatura SET status = 'atrasada', atualizado_em = now()
      WHERE status = 'emitida' AND vencimento < CURRENT_DATE - make_interval(days => :dias)
      RETURNING id, tenant_id`,
    { dias }
  );
  for (const row of r.rows) {
    await auditoria.registrar(conn, {
      operador: null, tenantId: Number(row.TENANT_ID), acao: 'fatura_atrasada', entidade: 'fatura', entidadeId: Number(row.ID),
      detalhe: { diasAtraso: dias, sugestao: 'revisar suspensão do tenant' },
    });
  }
  return r.rows.length;
}

/** Um tick: gera a fatura do mês ANTERIOR (o único já encerrado — ver
 *  cabeçalho; idempotente, cobre também o primeiro tick após o boot) e marca
 *  atrasadas. */
async function tick() {
  try {
    await comOperador(async (conn) => {
      if (!(await tentarGlobal(conn, 'fatura'))) return; // outra instância já está rodando o tick
      await gerarFaturas(conn, mesAnteriorDe(new Date()));
      await marcarAtrasadas(conn);
    });
  } catch (err) {
    console.error('[financeiro] rotina de faturamento falhou:', err.message);
  }
}

function iniciar() {
  if (timer) return;
  tick().catch(() => {}); // primeira rodada já no boot — não espera 24h
  timer = setInterval(tick, INTERVALO_MS);
  if (timer.unref) timer.unref();
}

function parar() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  gerarFaturas, gerarFaturaDoTenant, marcarAtrasadas, tick, iniciar, parar,
  anoMesAtual, mesAnteriorDe, valorDaParcela, vencimentoDe, deveCobrarRecorrencia,
  DIAS_ATRASO_PADRAO,
};
