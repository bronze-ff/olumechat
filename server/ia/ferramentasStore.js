// server/ia/ferramentasStore.js — o que a IA de UMA empresa pode fazer neste
// momento: quais ferramentas estão ligadas, quais tags existem para ela aplicar
// e qual é o template de pedido (FIL-85).
//
// POR QUE ISTO É UM STORE E NÃO CONSTANTE: o schema enviado ao provedor deixou
// de ser fixo. `aplicar_tag` lista as tags DAQUELA empresa como enum e
// `registrar_pedido` tem os parâmetros do template DAQUELA empresa — duas
// coisas que vivem no banco e mudam quando o admin mexe na tela.
//
// ⚠️ RECEBE `conn` — mesmo contrato do ia/perfilStore.js e pela mesma razão: o
// conteúdo é 100% do tenant e é lido pela conexão que o chamador já tem aberta
// (fase 3 do ia/runtime.js). Abrir conexão própria aqui faria uma requisição
// segurar DUAS do pool ao mesmo tempo — o defeito que as 3 fases do runtime
// existem para evitar.
//
// Cache Map com TTL 60s POR TENANT (um cache global vazaria as tags de uma
// empresa para outra). Toda escrita de ferramenta/template/tag chama
// invalidar(tenantId) — sem isso o admin liga a ferramenta e continua vendo a
// IA sem ela por até 60s.
'use strict';

const db = require('../db/pool');
const pedidoTemplate = require('./pedidoTemplate');

const TTL_MS = 60_000;
const cache = new Map(); // tenantId (string) -> { valor, exp }

/** Teto de tags no enum da ferramenta. O enum inteiro vai no schema a CADA
 *  mensagem: uma empresa com 300 tags pagaria isso por turno, e um enum tão
 *  grande piora a escolha do modelo. As tags são ordenadas por nome — o corte é
 *  estável, não aleatório. */
const MAX_TAGS = 40;

const ESTADO_VAZIO = Object.freeze({ habilitacao: Object.freeze({}), tags: Object.freeze([]), template: null });

async function lerHabilitacaoETemplate(conn, tenantId) {
  const f = await conn.execute(
    `SELECT NOME, ATIVO FROM ia_ferramenta WHERE tenant_id = :tenantId`,
    { tenantId }
  );
  const habilitacao = {};
  for (const linha of f.rows || []) habilitacao[linha.NOME] = linha.ATIVO === 'S' ? 'S' : 'N';

  const t = await conn.execute(
    `SELECT TITULO, CAMPOS FROM ia_pedido_template WHERE tenant_id = :tenantId`,
    { tenantId }
  );
  const linha = (t.rows || [])[0];
  const template = linha
    ? pedidoTemplate.normalizarSalvo({
      titulo: linha.TITULO,
      // jsonb já chega decodificado pelo driver `pg`; o parse é defensivo.
      campos: typeof linha.CAMPOS === 'string' ? JSON.parse(linha.CAMPOS) : linha.CAMPOS,
    })
    : null;

  return { habilitacao, template };
}

/**
 * Estado das ferramentas do tenant, com cache de 60s.
 * @param {object} conn conexão de tenant JÁ ABERTA pelo chamador (ver ⚠️ no topo)
 * @param {number} tenantId
 * @returns {Promise<{habilitacao: object, tags: {id, nome}[], template: object|null}>}
 */
async function carregar(conn, tenantId) {
  const chave = String(tenantId);
  const hit = cache.get(chave);
  if (hit && hit.exp > Date.now()) return hit.valor;

  // `tag` existe desde a migração 001 e é lida fora do savepoint. As duas
  // tabelas da 022 podem não existir num ambiente com a migração pendente: o
  // 42P01 abortaria a transação INTEIRA do chamador — que é a transação que
  // responde ao cliente. Isolado, a IA segue sem as ferramentas novas.
  const tagsRows = await conn.execute(
    `SELECT ID, NOME FROM tag WHERE tenant_id = :tenantId ORDER BY NOME LIMIT :limite`,
    { tenantId, limite: MAX_TAGS }
  );
  const tags = (tagsRows.rows || []).map((r) => ({ id: r.ID, nome: r.NOME }));

  let habilitacao = {};
  let template = null;
  try {
    const lido = await db.comSavepoint(conn, () => lerHabilitacaoETemplate(conn, tenantId));
    habilitacao = lido.habilitacao;
    template = lido.template;
  } catch (err) {
    if (err.code !== '42P01') throw err;
    console.error('[ia] ia_ferramenta/ia_pedido_template ainda não existem — rode as migrações (npm run migrar)');
  }

  const valor = { habilitacao, tags, template };
  cache.set(chave, { valor, exp: Date.now() + TTL_MS });
  return valor;
}

/** Invalida o cache de um tenant (ou de todos, se omitido). Chamada por toda
 *  escrita de ferramenta, template e TAG — a tag entra no schema como enum. */
function invalidar(tenantId) {
  if (tenantId === undefined) cache.clear();
  else cache.delete(String(tenantId));
}

module.exports = { carregar, invalidar, MAX_TAGS, TTL_MS, ESTADO_VAZIO };
