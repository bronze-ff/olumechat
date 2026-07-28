// operador/onboarding.js — "Quem está travado em qual etapa" (FIL-81).
//
// CROSS-TENANT DE PROPÓSITO: é a tela que o operador usa para ver a carteira
// inteira lado a lado, não o acompanhamento de UM cliente (esse é feito
// dentro da sessão de suporte, em api/onboardingMeta.js). Roda em
// comOperador() — nomeia `tenant_id` explicitamente, como todo o resto deste
// módulo (ver cabeçalho de operador/db.js).
'use strict';

const { comOperador } = require('./db');
const { ETAPAS } = require('../onboardingMeta/etapas');

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

module.exports = { listarProgresso };
