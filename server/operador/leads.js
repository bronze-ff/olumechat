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
const POR_PAGINA = 50;
const POR_PAGINA_MAX = 200;

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
 * Listagem para o painel (mais recentes primeiro), com PAGINAÇÃO POR CURSOR —
 * mesmo padrão de api/iaPedidos.js (FIL-85, achado [P2] da review do PR #42:
 * um `LIMIT 500` sem continuação deixava lead antigo inalcançável, e a tela
 * ainda mostrava `lista.length` como se fosse o total). `id` é IDENTITY
 * (monotônico), então "tudo com id menor que o cursor" é uma página exata —
 * mesmo com lead novo chegando entre uma página e outra.
 * @param {{ status?: string, antes?: number, limite?: number }} [filtros]
 * @returns {Promise<{ itens: object[], proximo: number|null }>}
 */
async function listar(filtros = {}) {
  if (filtros.status && !STATUS.includes(filtros.status)) throw new ErroOperador(400, 'Status inválido.');
  const limite = Math.min(POR_PAGINA_MAX, Math.max(1, Number(filtros.limite) || POR_PAGINA));
  const antes = idValido(filtros.antes);

  const condicoes = [];
  // Pede uma linha A MAIS do que cabe na página: se ela vier, há próxima —
  // sem precisar de um COUNT(*) da tabela inteira a cada rolagem.
  const binds = { limite: limite + 1 };
  if (filtros.status) { condicoes.push('status = :status'); binds.status = filtros.status; }
  if (antes) { condicoes.push('id < :antes'); binds.antes = antes; }
  const filtro = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  return comOperador(async (conn) => {
    const r = await conn.execute(
      `SELECT id, nome, empresa, email, tamanho_equipe, origem, status, observacao, criado_em, atualizado_em
         FROM lead_comercial
         ${filtro}
        ORDER BY id DESC
        LIMIT :limite`,
      binds
    );
    const linhas = r.rows || [];
    const temMais = linhas.length > limite;
    const itens = linhas.slice(0, limite);
    return { itens, proximo: temMais && itens.length ? Number(itens[itens.length - 1].ID) : null };
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
 * Marca contatado/descartado e/ou atualiza a nota — os dois campos são
 * INDEPENDENTES de propósito (achados [P2] da review do PR #42):
 *
 *  • `observacao` OMITIDA (undefined) preserva a nota já gravada — "marcar
 *    status sem reescrever a nota". `observacao` EXPLICITAMENTE '' APAGA a
 *    nota: antes, `limitar('')` virava null e um COALESCE restaurava o valor
 *    antigo, então "apagar a nota" respondia sucesso e não mudava nada.
 *  • `status` também é OMISSÍVEL — é o que permite ao front salvar só a nota
 *    sem reenviar o status que tinha em memória quando abriu o editor. Sem
 *    isso, um segundo operador podia mudar o status enquanto o primeiro ainda
 *    escrevia a nota, e "Salvar" sobrescrevia o status novo com o velho.
 *
 * Auditado — mesma regra do resto do painel: toda ação de operador entra em
 * `operador_auditoria`, com `tenant_id` NULO (o lead não é de tenant nenhum).
 * @param {{ operador: object, id: number, status?: string, observacao?: string, ip?: string }} dados
 */
async function atualizarStatus({ operador, id, status, observacao, ip }) {
  const leadId = idValido(id);
  if (!leadId) throw new ErroOperador(400, 'ID de lead inválido.');

  const statusFornecido = status !== undefined && status !== null;
  const observacaoFornecida = observacao !== undefined;
  if (!statusFornecido && !observacaoFornecida) {
    throw new ErroOperador(400, 'Informe status e/ou observação para atualizar.');
  }
  if (statusFornecido && !STATUS.includes(status)) throw new ErroOperador(400, 'Status inválido.');

  const sets = ['atualizado_em = now()'];
  const binds = { id: leadId };
  if (statusFornecido) { sets.push('status = :status'); binds.status = status; }
  if (observacaoFornecida) { sets.push('observacao = :observacao'); binds.observacao = limitar(observacao, 2000); }

  return comOperador(async (conn) => {
    const r = await conn.execute(
      `UPDATE lead_comercial
          SET ${sets.join(', ')}
        WHERE id = :id
        RETURNING id, nome, empresa, email, tamanho_equipe, origem, status, observacao, criado_em, atualizado_em`,
      binds
    );
    if (!r.rows.length) throw new ErroOperador(404, 'Lead não encontrado.');
    await auditoria.registrar(conn, {
      operador,
      acao: statusFornecido ? 'lead_status_alterado' : 'lead_observacao_atualizada',
      entidade: 'lead_comercial', entidadeId: leadId,
      detalhe: statusFornecido ? { status } : null,
      ip,
    });
    return r.rows[0];
  });
}

module.exports = { criar, listar, contarNovos, atualizarStatus, STATUS };
