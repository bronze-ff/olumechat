// server/ia/handoff.js — o caminho de SAÍDA do modo IA, que até o FIL-84 não
// existia projetado: `fila_status='ia'` era atribuído UMA única vez, na criação
// da conversa (webhook/processEvent.js), e nada nunca o mudava de volta. As
// únicas saídas eram acidentais.
//
// UMA cascata, TRÊS chamadores:
//   1. api/numeros.js — o operador/admin tira o número do modo IA (cascata do
//      MODO: pode cair no bot de fluxo, por isso `permitirFluxo`).
//   2. ia/operacoes.js — a IA chama `transferir_para_humano`.
//   3. api/conversas.js — o atendente clica em Assumir.
// A mesma regra duplicada nesses três lugares é exatamente como o bug do
// "canal restrito para sempre" nasceu na primeira vez.
//
// TODA função recebe a `conn` do chamador (já dentro de um db.comTenant) e
// NUNCA abre transação própria — quem transfere está no meio da transação de
// outro (runtime da IA, rota HTTP), e uma segunda conexão do pool pela mesma
// requisição é o defeito que o FIL-78 corrigiu.
'use strict';

const { gerarProtocolo } = require('../fila/protocolo');

/**
 * Para onde vai a conversa ao sair da IA.
 * @param {object} conn conexão já em contexto de tenant
 * @param {number} tenantId
 * @param {number|null} numeroId canal da conversa
 * @param {{departamentoId?: number|null, permitirFluxo?: boolean}} opts
 *   departamentoId — destino pedido (da ferramenta); ignorado se inválido/inativo.
 *   permitirFluxo  — só a cascata do MODO devolve o cliente ao bot de fluxo;
 *                    o handoff IA→humano nunca faz isso (o cliente pediu gente).
 * @returns {Promise<{departamentoId: number|null, filaStatus: string, fluxoId: number|null}>}
 */
async function resolverDestino(conn, tenantId, numeroId, { departamentoId = null, permitirFluxo = false } = {}) {
  if (departamentoId) {
    const dep = await conn.execute(
      `SELECT id FROM departamento WHERE tenant_id = :tenantId AND id = :d AND ativo = 'S'`,
      { tenantId, d: Number(departamentoId) }
    );
    if (dep.rows.length) {
      return { departamentoId: dep.rows[0].ID, filaStatus: 'aguardando', fluxoId: null };
    }
    // Departamento inválido/inativo NÃO é erro: a IA chutou um nome e a cascata
    // segue para o padrão do número. Melhor um destino razoável do que um erro
    // que o cliente final acabaria vendo.
  }

  const fx = await conn.execute(
    `SELECT n.departamento_padrao_id AS dep, f.id AS fluxo_id
       FROM numero n
       LEFT JOIN fluxo f ON f.tenant_id = n.tenant_id AND f.numero_id = n.id AND f.ativo = 'S'
      WHERE n.tenant_id = :tenantId AND n.id = :id`,
    { tenantId, id: numeroId }
  );
  const linha = fx.rows[0] || {};
  const fluxoId = (permitirFluxo && linha.FLUXO_ID) || null;
  if (fluxoId) return { departamentoId: null, filaStatus: 'bot', fluxoId };
  const dep = linha.DEP || null;
  return { departamentoId: dep, filaStatus: dep ? 'aguardando' : 'em_atendimento', fluxoId: null };
}

/** Departamento ATIVO pelo NOME (o modelo escolhe por nome, nunca por id). */
async function acharDepartamentoPorNome(conn, tenantId, nome) {
  const alvo = String(nome || '').trim().toLowerCase();
  if (!alvo) return null;
  const r = await conn.execute(
    `SELECT id FROM departamento
      WHERE tenant_id = :tenantId AND lower(nome) = :nome AND ativo = 'S'
      ORDER BY id LIMIT 1`,
    { tenantId, nome: alvo }
  );
  return r.rows.length ? r.rows[0].ID : null;
}

/**
 * IA → humano. Só age se a conversa AINDA estiver em `fila_status='ia'`: entre
 * a decisão da IA e este UPDATE, o atendente pode ter assumido.
 * @param {object} ctx {conversaId, contatoId, numeroId}
 * @returns {Promise<{ok, departamentoId, departamentoNome, filaStatus, protocolo, eventos}>}
 */
async function transferirParaHumano(conn, tenantId, ctx, { departamentoId = null, motivo = null } = {}) {
  const destino = await resolverDestino(conn, tenantId, ctx.numeroId, { departamentoId });

  const atual = await conn.execute(
    `SELECT fila_status, protocolo FROM conversa WHERE tenant_id = :tenantId AND id = :id`,
    { tenantId, id: ctx.conversaId }
  );
  const recusa = { ok: false, departamentoId: null, departamentoNome: null, filaStatus: null, protocolo: null, eventos: [] };
  if (!atual.rows.length || atual.rows[0].FILA_STATUS !== 'ia') return recusa;
  const protocolo = atual.rows[0].PROTOCOLO || await gerarProtocolo(conn);

  let departamentoNome = null;
  if (destino.departamentoId) {
    const d = await conn.execute(
      `SELECT nome FROM departamento WHERE tenant_id = :tenantId AND id = :d`,
      { tenantId, d: destino.departamentoId });
    departamentoNome = (d.rows[0] || {}).NOME || null;
  }

  const upd = await conn.execute(
    `UPDATE conversa
        SET fila_status = :st,
            departamento_id = :dep,
            atendente_id = NULL,
            protocolo = :prot,
            fila_entrou_em = now()
      WHERE tenant_id = :tenantId AND id = :id AND fila_status = 'ia'`,
    { tenantId, id: ctx.conversaId, st: destino.filaStatus, dep: destino.departamentoId, prot: protocolo }
  );
  if (!upd.rowsAffected) return recusa;

  // Timeline: a transferência da IA aparece como evento de SISTEMA (spec §Tela).
  const txt = `🤖 A IA transferiu para ${departamentoNome ? `o departamento ${departamentoNome}` : 'o atendimento humano'}`
    + (motivo ? ` — motivo: ${String(motivo).slice(0, 300)}` : '') + '.';
  await conn.execute(
    `INSERT INTO mensagem (tenant_id, conversa_id, contato_id, direcao, tipo, conteudo, origem, ts)
     VALUES (:tenantId, :cv, :ct, 'nota', 'text', :txt, :origem, now())`,
    { tenantId, cv: ctx.conversaId, ct: ctx.contatoId, txt, origem: 'sistema' }
  );

  const eventos = [{ tipo: 'conversa', conversaId: ctx.conversaId, departamentoId: destino.departamentoId }];
  if (destino.departamentoId) {
    eventos.push({ tipo: 'fila', conversaId: ctx.conversaId, departamentoId: destino.departamentoId, protocolo });
  }
  return { ok: true, departamentoId: destino.departamentoId, departamentoNome, filaStatus: destino.filaStatus, protocolo, eventos };
}

/**
 * Humano → IA. NUNCA automático (decisão da spec): é sempre ação explícita do
 * atendente. Limpa o estado de fila por completo — senão a conversa volta para
 * a IA ainda "pertencendo" a um departamento/atendente e reaparece na fila dele.
 * @returns {Promise<boolean>} false se a conversa não estava com humano
 */
async function devolverParaIa(conn, tenantId, conversaId) {
  const upd = await conn.execute(
    `UPDATE conversa
        SET fila_status = 'ia',
            departamento_id = NULL,
            atendente_id = NULL,
            fila_entrou_em = NULL
      WHERE tenant_id = :tenantId AND id = :id
        AND fila_status IN ('aguardando', 'em_atendimento')`,
    { tenantId, id: conversaId }
  );
  return Boolean(upd.rowsAffected);
}

module.exports = { resolverDestino, acharDepartamentoPorNome, transferirParaHumano, devolverParaIa };
