// operador/onboarding.js — "Quem está travado em qual etapa" (FIL-81).
//
// CROSS-TENANT DE PROPÓSITO: é a tela que o operador usa para ver a carteira
// inteira lado a lado, não o acompanhamento de UM cliente (esse é feito
// dentro da sessão de suporte, em api/onboardingMeta.js). Roda em
// comOperador() — nomeia `tenant_id` explicitamente, como todo o resto deste
// módulo (ver cabeçalho de operador/db.js).
'use strict';

const { comOperador } = require('./db');
const auditoria = require('./auditoria');
const { ErroOperador } = require('./erroOperador');
const { ETAPAS, CHAVES, STATUS } = require('../onboardingMeta/etapas');
const { validarDataYYYYMMDD, paraDataTexto } = require('../utils/data');

function textoOpcional(v, max) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

async function carregarTenant(conn, tenantId) {
  const r = await conn.execute(`SELECT id FROM tenant WHERE id = :id`, { id: tenantId });
  if (!r.rows.length) throw new ErroOperador(404, 'Tenant não encontrado.');
}

/**
 * Progresso do onboarding assistido de cada tenant, com a etapa em que cada
 * um está parado agora (a primeira, na ordem fixa, que ainda não está
 * concluída).
 */
async function listarProgresso() {
  return comOperador(async (conn) => {
    const t = await conn.execute(`SELECT id, nome, slug, status FROM tenant ORDER BY nome`);
    const e = await conn.execute(
      `SELECT tenant_id, etapa, status, atualizado_em FROM onboarding_meta_etapa`
    );

    const porTenant = new Map();
    for (const row of e.rows) {
      const lista = porTenant.get(row.TENANT_ID) || [];
      lista.push(row);
      porTenant.set(row.TENANT_ID, lista);
    }

    return t.rows.map((tenant) => {
      const linhas = porTenant.get(tenant.ID) || [];
      const porChave = new Map(linhas.map((l) => [l.ETAPA, l]));

      let concluidas = 0;
      let etapaAtual = null;
      for (const def of ETAPAS) {
        const l = porChave.get(def.chave);
        const status = l ? l.STATUS : 'pendente';
        if (status === 'concluida') { concluidas += 1; continue; }
        if (!etapaAtual) {
          etapaAtual = {
            etapa: def.chave,
            titulo: def.titulo,
            status,
            atualizadoEm: l ? l.ATUALIZADO_EM : null,
          };
        }
      }

      return {
        tenantId: tenant.ID,
        tenantNome: tenant.NOME,
        tenantSlug: tenant.SLUG,
        tenantStatus: tenant.STATUS,
        etapasConcluidas: concluidas,
        etapasTotal: ETAPAS.length,
        concluido: concluidas === ETAPAS.length,
        etapaAtual,
        travado: etapaAtual ? etapaAtual.status === 'bloqueada' : false,
      };
    });
  });
}

/**
 * As 7 etapas fixas de UM tenant, mescladas com o que já existe no banco —
 * mesmo formato de api/onboardingMeta.js::mesclar(), só que lido via
 * comOperador (cross-tenant, filtra tenant_id explicitamente em vez de
 * depender da RLS de uma sessão de suporte). Usada pela tela de Contratos/
 * ficha financeira para editar a etapa sem precisar abrir acesso de suporte.
 */
async function listarEtapasDoTenant(tenantId) {
  return comOperador(async (conn) => {
    await carregarTenant(conn, tenantId);
    const r = await conn.execute(
      `SELECT * FROM onboarding_meta_etapa WHERE tenant_id = :tid`,
      { tid: tenantId }
    );
    const porChave = new Map(r.rows.map((l) => [l.ETAPA, l]));
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
  });
}

function validarEtapaDados(dados) {
  const status = String((dados && dados.status) || '');
  if (!STATUS.includes(status)) throw new ErroOperador(400, `Status inválido (use: ${STATUS.join(', ')}).`);
  const responsavel = textoOpcional(dados.responsavel, 160);
  const observacao = textoOpcional(dados.observacao, 500);
  const dataReferencia = dados.dataReferencia ? validarDataYYYYMMDD(dados.dataReferencia, 'Data de referência', ErroOperador) : null;
  return { status, responsavel, observacao, dataReferencia };
}

/**
 * Atualiza (upsert) UMA etapa de UM tenant a partir da visão cross-tenant do
 * operador — equivalente ao `PUT /api/onboarding-meta/:etapa` que já existe
 * para a sessão de SUPORTE (api/onboardingMeta.js), mas sem exigir que o
 * operador abra uma sessão de suporte só para marcar uma etapa. Audita
 * ANTES/DEPOIS de todo campo editável, mesmo racional documentado lá.
 */
async function atualizarEtapa({ operador, tenantId, etapa, dados, ip }) {
  const chave = String(etapa || '');
  if (!CHAVES.includes(chave)) throw new ErroOperador(400, 'Etapa desconhecida.');
  const v = validarEtapaDados(dados || {});
  return comOperador(async (conn) => {
    await carregarTenant(conn, tenantId);
    const antesR = await conn.execute(
      `SELECT status, responsavel, observacao, data_referencia FROM onboarding_meta_etapa WHERE tenant_id = :tid AND etapa = :etapa`,
      { tid: tenantId, etapa: chave }
    );
    const l = antesR.rows[0] || null;
    const antes = {
      status: l ? l.STATUS : 'pendente',
      responsavel: l ? l.RESPONSAVEL : null,
      observacao: l ? l.OBSERVACAO : null,
      dataReferencia: l ? paraDataTexto(l.DATA_REFERENCIA) : null,
    };

    await conn.execute(
      `INSERT INTO onboarding_meta_etapa
         (tenant_id, etapa, status, responsavel, observacao, data_referencia, atualizado_por, atualizado_em)
       VALUES (:tid, :etapa, :status, :resp, :obs, :dataRef, :atzPor, now())
       ON CONFLICT (tenant_id, etapa) DO UPDATE SET
         status = EXCLUDED.status, responsavel = EXCLUDED.responsavel,
         observacao = EXCLUDED.observacao, data_referencia = EXCLUDED.data_referencia,
         atualizado_por = EXCLUDED.atualizado_por, atualizado_em = now()`,
      {
        tid: tenantId, etapa: chave, status: v.status, resp: v.responsavel,
        obs: v.observacao, dataRef: v.dataReferencia, atzPor: operador.email || null,
      }
    );

    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'onboarding_etapa_atualizada', entidade: 'onboarding_meta_etapa',
      detalhe: { etapa: chave, antes, depois: v },
      ip,
    });

    return { ok: true, etapa: chave, status: v.status, statusAnterior: antes.status };
  });
}

module.exports = { listarProgresso, listarEtapasDoTenant, atualizarEtapa };
