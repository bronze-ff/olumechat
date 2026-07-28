// api/onboardingMeta.js — Checklist do onboarding assistido da Meta (FIL-81).
//
// 100% do operador: o cliente NUNCA vê nem edita isto (Escopo do ticket). A
// guarda é a mesma de api/numeros.js/meta.js — `exigirSuporteOperador` —:
// só uma sessão de SUPORTE (o operador atuando dentro do tenant, decisão de
// produto documentada em auth/middleware.js) passa; qualquer JWT de tenant
// comum (ATENDENTE, SUPERVISOR, ADMIN sem suporte) recebe 403, mesmo sendo
// leitura — não há tela do cliente para isto, então não há razão para GET
// liberado.
//
// A mutação já cai na trilha genérica de suporte (auth/middleware.js grava
// `suporte_mutacao` em toda escrita de sessão de suporte). Além dela, cada
// troca de etapa grava uma entrada PRÓPRIA aqui — com o ANTES e o DEPOIS de
// TODO campo editável (status, responsável, observação, data de referência),
// não só o status — porque a entrada genérica só registra método+caminho, e
// o ticket promete uma trilha reconstruível (docs/SEGURANCA.md item 12).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { ETAPAS, CHAVES, STATUS, ULTIMA_ETAPA } = require('../onboardingMeta/etapas');

const router = express.Router();

function exigirSuporteOperador(req, res, next) {
  if (req.user && req.user.suporte === true) return next();
  return res.status(403).json({
    error: 'O onboarding assistido da Meta é acompanhado pelo operador em um acesso de suporte.',
  });
}
router.use(exigirSuporteOperador);

/**
 * DATE do Postgres chega como `Date` interpretado em hora LOCAL do processo
 * (pg-types faz `new Date(ano, mês, dia)`, não UTC — ver postgres-date). Ler
 * os componentes locais (getFullYear/getMonth/getDate) evita a armadilha de
 * `toISOString()` (que converte pra UTC e pode empurrar a data em um fuso
 * positivo) — mesma classe de bug do achado do client sobre data sem fuso.
 */
function paraDataTexto(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

/** Mescla as 7 etapas fixas com o que já existe no banco (etapa sem linha = 'pendente'). */
function mesclar(linhas) {
  const porChave = new Map(linhas.map((l) => [l.ETAPA, l]));
  return ETAPAS.map((def, idx) => {
    const l = porChave.get(def.chave);
    return {
      ordem: idx + 1,
      etapa: def.chave,
      titulo: def.titulo,
      descricao: def.descricao,
      status: l ? l.STATUS : 'pendente',
      responsavel: l ? l.RESPONSAVEL : null,
      observacao: l ? l.OBSERVACAO : null,
      dataReferencia: l ? paraDataTexto(l.DATA_REFERENCIA) : null,
      atualizadoPor: l ? l.ATUALIZADO_POR : null,
      atualizadoEm: l && l.ATUALIZADO_EM instanceof Date ? l.ATUALIZADO_EM.toISOString() : (l ? l.ATUALIZADO_EM : null),
    };
  });
}

// GET /api/onboarding-meta — as 7 etapas do tenant corrente, na ordem do processo.
router.get('/', async (req, res, next) => {
  try {
    const linhas = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(`SELECT * FROM onboarding_meta_etapa`);
      return r.rows;
    });
    res.json(mesclar(linhas));
  } catch (err) {
    next(err);
  }
});

// PUT /api/onboarding-meta/:etapa  { status, responsavel?, observacao?, dataReferencia? }
router.put('/:etapa', async (req, res, next) => {
  const etapa = String(req.params.etapa || '');
  if (!CHAVES.includes(etapa)) return res.status(400).json({ error: 'Etapa desconhecida.' });
  const status = String((req.body && req.body.status) || '');
  if (!STATUS.includes(status)) {
    return res.status(400).json({ error: `Status inválido. Use um de: ${STATUS.join(', ')}` });
  }
  const b = req.body || {};
  const responsavel = b.responsavel != null ? String(b.responsavel).trim().slice(0, 160) || null : null;
  const observacao = b.observacao != null ? String(b.observacao).trim().slice(0, 500) || null : null;
  const dataReferencia = b.dataReferencia ? String(b.dataReferencia).slice(0, 10) : null;
  const operador = req.user || {};

  try {
    const { anterior, todasConcluidas } = await db.comTenant(req.tenantId, async (conn) => {
      const antes = await conn.execute(
        `SELECT status, responsavel, observacao, data_referencia FROM onboarding_meta_etapa WHERE etapa = :etapa`,
        { etapa }
      );
      const l = antes.rows[0] || null;
      const anterior = {
        status: l ? l.STATUS : 'pendente',
        responsavel: l ? l.RESPONSAVEL : null,
        observacao: l ? l.OBSERVACAO : null,
        dataReferencia: l ? paraDataTexto(l.DATA_REFERENCIA) : null,
      };

      await conn.execute(
        `INSERT INTO onboarding_meta_etapa
           (etapa, status, responsavel, observacao, data_referencia, atualizado_por, atualizado_em)
         VALUES (:etapa, :status, :resp, :obs, :dataRef, :atzPor, now())
         ON CONFLICT (tenant_id, etapa) DO UPDATE SET
           status = EXCLUDED.status, responsavel = EXCLUDED.responsavel,
           observacao = EXCLUDED.observacao, data_referencia = EXCLUDED.data_referencia,
           atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
        { etapa, status, resp: responsavel, obs: observacao, dataRef: dataReferencia, atzPor: operador.email || null }
      );

      await conn.execute(
        `INSERT INTO auditoria (acao, entidade, detalhe)
         VALUES ('onboarding_etapa_atualizada', 'onboarding_meta_etapa', :det)`,
        {
          det: JSON.stringify({
            etapa,
            antes: anterior,
            depois: { status, responsavel, observacao, dataReferencia },
            operadorId: operador.operadorId || null,
            operador: operador.email || null,
          }),
        }
      );

      // Todas as 7 etapas concluídas, contando a que acabou de ser gravada
      // (a query abaixo lê a transação em andamento, então já enxerga o
      // upsert de cima).
      const todas = await conn.execute(`SELECT etapa, status FROM onboarding_meta_etapa`);
      const statusPorEtapa = new Map(todas.rows.map((r) => [r.ETAPA, r.STATUS]));
      const todasConcluidas = CHAVES.every((c) => statusPorEtapa.get(c) === 'concluida');

      return { anterior, todasConcluidas };
    });

    const resposta = { ok: true, etapa, status, statusAnterior: anterior.status };
    // Etapa 7 concluída = gatilho natural do início de cobrança (FIL-76, ainda
    // não mergeado — ver docs/PORTE.md §3.2). Só SUGERE: nenhum contrato é
    // alterado por aqui. Quando o módulo de contrato existir, ele consome esta
    // sugestão para preencher (não decidir sozinho) a data de início.
    //
    // Três condições, as três necessárias:
    //  • é a etapa 7 (webhook testado) que mudou;
    //  • ela REALMENTE virou 'concluida' agora — sem isso, salvar só uma
    //    anotação numa etapa 7 já concluída dispararia uma sugestão NOVA a
    //    cada vez, empurrando a data;
    //  • TODAS as 7 etapas estão concluídas — sem isso, marcar a etapa 7 como
    //    concluída com etapas anteriores pendentes/bloqueadas anunciaria
    //    "onboarding completo" contradizendo o resto do checklist.
    const completouAgora = etapa === ULTIMA_ETAPA && status === 'concluida'
      && anterior.status !== 'concluida' && todasConcluidas;
    if (completouAgora) {
      resposta.sugestaoInicioCobranca = {
        data: new Date().toISOString().slice(0, 10),
        motivo: 'Webhook testado ponta a ponta — onboarding assistido concluído.',
      };
    }
    res.json(resposta);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
