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
// troca de etapa grava uma entrada PRÓPRIA aqui — com a etapa, o status
// antes/depois e a anotação — porque a entrada genérica só registra
// método+caminho, não o que mudou de fato.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { ETAPAS, CHAVES, STATUS, ULTIMA_ETAPA } = require('../onboardingMeta/etapas');

const router = express.Router();

function exigirSuporteOperador(req, res, next) {
  if (req.user && req.user.suporte === true) return next();
  return res.status(403).json({
    error: 'O onboarding assistido da Meta é acompanhado pelo operador em um acesso de suporte.',
  });
}
router.use(exigirSuporteOperador);

/** Mescla as 7 etapas fixas com o que já existe no banco (etapa sem linha = 'pendente'). */
function mesclar(linhas) {
  const porChave = new Map(mapRows(linhas).map((l) => [l.etapa, l]));
  return ETAPAS.map((def, idx) => {
    const l = porChave.get(def.chave);
    return {
      ordem: idx + 1,
      etapa: def.chave,
      titulo: def.titulo,
      descricao: def.descricao,
      status: l ? l.status : 'pendente',
      responsavel: l ? l.responsavel : null,
      observacao: l ? l.observacao : null,
      dataReferencia: l ? l.dataReferencia : null,
      atualizadoPor: l ? l.atualizadoPor : null,
      atualizadoEm: l ? l.atualizadoEm : null,
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
    const { statusAnterior } = await db.comTenant(req.tenantId, async (conn) => {
      const antes = await conn.execute(
        `SELECT status FROM onboarding_meta_etapa WHERE etapa = :etapa`, { etapa }
      );
      const statusAnterior = antes.rows.length ? antes.rows[0].STATUS : 'pendente';

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
            etapa, statusAnterior, statusNovo: status, observacao,
            operadorId: operador.operadorId || null, operador: operador.email || null,
          }),
        }
      );

      return { statusAnterior };
    });

    const resposta = { ok: true, etapa, status, statusAnterior };
    // Etapa 7 concluída = gatilho natural do início de cobrança (FIL-76, ainda
    // não mergeado — ver docs/PORTE.md §3.2). Só SUGERE: nenhum contrato é
    // alterado por aqui. Quando o módulo de contrato existir, ele consome esta
    // sugestão para preencher (não decidir sozinho) a data de início.
    if (etapa === ULTIMA_ETAPA && status === 'concluida') {
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
