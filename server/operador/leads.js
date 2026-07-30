// operador/leads.js — Leads comerciais da landing (FIL-96).
//
// `lead_comercial` é FECHADA para o caminho de tenant (migração 025, mesmo
// padrão RLS-deny de `operador`/`provedor_credencial`) — tudo aqui roda em
// comOperador() (contexto de tenant NULO). O INSERT público (formulário da
// landing, sem sessão de operador) também passa por comOperador(): é o único
// caminho que atravessa a policy USING(false), e o dado nasce sem
// `operador`/`ip` de auditoria porque quem preencheu não é ninguém do time.
'use strict';

const { comOperador, idValido } = require('./db');
const auditoria = require('./auditoria');
const { ErroOperador } = require('./erroOperador');

const STATUS = Object.freeze(['novo', 'contatado', 'descartado']);

/** Corta o que não cabe na coluna em vez de estourar o INSERT. */
function limitar(valor, max) {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Grava um lead novo. Chamado pelo endpoint público POST /api/leads — sem
 * sessão de operador, sem `tenantId`. Falha silenciosa de negócio (honeypot,
 * validação) é tratada ANTES de chegar aqui, em server/api/leads.js.
 * @param {{ nome: string, empresa: string, email: string, tamanhoEquipe?: string,
 *           origem?: string, userAgent?: string, ip?: string }} dados
 */
async function criar(dados) {
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `INSERT INTO lead_comercial (nome, empresa, email, tamanho_equipe, origem, user_agent, ip)
       VALUES (:nome, :empresa, :email, :tamanhoEquipe, :origem, :userAgent, :ip)
       RETURNING id, criado_em`,
      {
        nome: limitar(dados.nome, 160),
        empresa: limitar(dados.empresa, 160),
        email: limitar(dados.email, 160),
        tamanhoEquipe: limitar(dados.tamanhoEquipe, 60),
        origem: limitar(dados.origem, 200),
        userAgent: limitar(dados.userAgent, 300),
        ip: limitar(dados.ip, 45),
      }
    );
    return r.rows[0];
  });
}

/**
 * Listagem para o painel (mais recentes primeiro). Filtro opcional por
 * status — sem filtro, devolve a carteira de leads inteira.
 * @param {{ status?: string }} [filtros]
 */
async function listar(filtros = {}) {
  const binds = {};
  let filtro = '';
  if (filtros.status) {
    if (!STATUS.includes(filtros.status)) throw new ErroOperador(400, 'Status inválido.');
    filtro = 'WHERE status = :status';
    binds.status = filtros.status;
  }
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `SELECT id, nome, empresa, email, tamanho_equipe, origem, status, observacao, criado_em, atualizado_em
         FROM lead_comercial
         ${filtro}
        ORDER BY criado_em DESC
        LIMIT 500`,
      binds
    );
    return r.rows;
  });
}

/** Contagem de leads `novo` — o número do badge no menu. */
async function contarNovos() {
  return comOperador(async (conn) => {
    const r = await conn.execute(`SELECT count(*) AS novos FROM lead_comercial WHERE status = 'novo'`);
    return Number(r.rows[0].NOVOS) || 0;
  });
}

/**
 * Marca contatado/descartado (ou de volta para novo). Auditado — mesma
 * regra do resto do painel: toda ação de operador entra em
 * `operador_auditoria`, com `tenant_id` NULO (o lead não é de tenant nenhum).
 * @param {{ operador: object, id: number, status: string, observacao?: string, ip?: string }} dados
 */
async function atualizarStatus({ operador, id, status, observacao, ip }) {
  const leadId = idValido(id);
  if (!leadId) throw new ErroOperador(400, 'ID de lead inválido.');
  if (!STATUS.includes(status)) throw new ErroOperador(400, 'Status inválido.');

  return comOperador(async (conn) => {
    const r = await conn.execute(
      // COALESCE: sem `observacao` no corpo do PATCH (marcar status sem
      // reescrever a nota), a coluna mantém o valor já gravado.
      `UPDATE lead_comercial
          SET status = :status, observacao = COALESCE(:observacao, observacao), atualizado_em = now()
        WHERE id = :id
        RETURNING id, nome, empresa, email, tamanho_equipe, origem, status, observacao, criado_em, atualizado_em`,
      { id: leadId, status, observacao: limitar(observacao, 2000) }
    );
    if (!r.rows.length) throw new ErroOperador(404, 'Lead não encontrado.');
    await auditoria.registrar(conn, {
      operador, acao: 'lead_status_alterado', entidade: 'lead_comercial', entidadeId: leadId,
      detalhe: { status }, ip,
    });
    return r.rows[0];
  });
}

module.exports = { criar, listar, contarNovos, atualizarStatus, STATUS };
