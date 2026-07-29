// api/iaPedidos.js — os pedidos que a IA registrou e a equipe confere (FIL-85).
//
// A IA cria o pedido como RASCUNHO (ia/operacoes.js::registrar_pedido). Nada é
// enviado para sistema nenhum: o valor da fatia é o pedido chegar ESTRUTURADO
// para uma pessoa conferir, em vez de virar texto solto no meio da conversa.
//
// PAPÉIS: conferir/descartar é ato de ATENDIMENTO (ADMIN, SUPERVISOR,
// ATENDENTE); AUDITOR é somente-leitura em todo o produto e aqui também. Tudo
// atrás do add-on (`tenant.ia_habilitada`), como o resto da IA.
//
// ESCOPO: ADMIN e AUDITOR veem a carteira inteira; os demais veem os pedidos
// das conversas que a lista de conversas mostraria para eles — EXATAMENTE a
// mesma regra (api/conversas.js), incluindo a visibilidade exclusiva do
// atendente comum (conversa já atribuída a um colega some) e a restrição por
// CANAL. Achado de review (P1, PR #33): a primeira versão era mais larga que a
// de conversas em dois pontos (admitia conversa de colega dentro do
// departamento e ignorava `numeroIds`), e como o mesmo filtro guarda o
// conferir/descartar, virava porta lateral para ler e decidir pedido de
// conversa que o inbox esconde de propósito.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { exigirIaHabilitada } = require('../ia/gate');
const { publish } = require('../realtime/hub');

const router = express.Router();
router.use(exigirIaHabilitada);

const STATUS = ['rascunho', 'conferido', 'descartado'];
const PAPEIS_ATENDIMENTO = ['ADMIN', 'SUPERVISOR', 'ATENDENTE'];

function podeAgir(req, res, next) {
  if (!req.perfil) return res.status(401).json({ error: 'Perfil não carregado' });
  if (!PAPEIS_ATENDIMENTO.includes(req.perfil.papel)) {
    return res.status(403).json({ error: 'Sem permissão para conferir pedidos.' });
  }
  next();
}

/**
 * Filtro de visibilidade por papel — cópia fiel do escopo de api/conversas.js
 * (ver cabeçalho). Devolve '' para quem vê tudo (ADMIN/AUDITOR).
 * @param {object} binds objeto de binds do chamador, PREENCHIDO aqui dentro
 */
function filtroEscopo(perfil, binds) {
  if (!perfil || perfil.papel === 'ADMIN' || perfil.papel === 'AUDITOR') return '';

  // Visibilidade exclusiva: o ATENDENTE comum só vê a conversa atribuída a ELE
  // ou ainda SEM dono. Conversa já atribuída a um colega some — e com ela o
  // pedido dela. SUPERVISOR continua vendo todo o departamento, para supervisão.
  const semDono = perfil.papel === 'SUPERVISOR' ? '' : ' AND c.atendente_id IS NULL';
  const partes = [`(c.departamento_id IS NULL${semDono})`];
  if (perfil.atendenteId) {
    partes.push('c.atendente_id = :escopoAtd');
    binds.escopoAtd = perfil.atendenteId;
  }
  const deptoIds = perfil.deptoIds || [];
  if (deptoIds.length) {
    const ms = deptoIds.map((d, i) => { binds[`escDep${i}`] = d; return `:escDep${i}`; });
    partes.push(`(c.departamento_id IN (${ms.join(',')})${semDono})`);
  }
  let filtro = ` AND (${partes.join(' OR ')})`;

  // Escopo por NÚMERO (canal): atendente com canais cadastrados só vê conversa
  // desses canais (+ sem canal + as atribuídas a ele). Lista vazia = sem
  // restrição. É o que separa a operação ativa da receptiva no inbox — e o
  // pedido não pode ser a brecha que devolve o dado escondido lá.
  const numeroIds = perfil.numeroIds || [];
  if (numeroIds.length) {
    const partesNum = ['c.numero_id IS NULL'];
    const ns = numeroIds.map((n, i) => { binds[`escNum${i}`] = n; return `:escNum${i}`; });
    partesNum.push(`c.numero_id IN (${ns.join(',')})`);
    if (perfil.atendenteId) partesNum.push('c.atendente_id = :escopoAtd'); // já bindado acima
    filtro += ` AND (${partesNum.join(' OR ')})`;
  }
  return filtro;
}

/** payload jsonb → lista de campos para a tela, NA ORDEM DO TEMPLATE. Os
 *  rótulos vêm do PAYLOAD, não do template atual: template editado depois não
 *  pode reescrever o que estava num pedido antigo (é a razão de a cópia existir).
 *
 *  ⚠️ A ordem sai de `posicao`, gravada campo a campo no registro (ver
 *  ia/pedidoTemplate.js): `campos` é jsonb e o Postgres NÃO preserva a ordem
 *  das chaves — ele canonicaliza (chave curta primeiro, depois ordem de bytes).
 *  Confiar em `Object.keys` mostraria o pedido numa ordem que ninguém
 *  configurou. Pedido gravado antes desta correção não tem `posicao`: cai no
 *  fim, preservando a ordem em que veio do banco (nada quebra, só não melhora). */
function camposDoPayload(bruto) {
  const payload = typeof bruto === 'string' ? JSON.parse(bruto || '{}') : (bruto || {});
  const campos = payload.campos || {};
  return Object.keys(campos)
    .map((nome, ordemNoBanco) => ({
      nome,
      rotulo: campos[nome] && campos[nome].rotulo ? campos[nome].rotulo : nome,
      tipo: (campos[nome] && campos[nome].tipo) || 'texto',
      valor: campos[nome] ? campos[nome].valor : null,
      posicao: Number.isInteger(campos[nome] && campos[nome].posicao)
        ? campos[nome].posicao
        : Number.MAX_SAFE_INTEGER - 1000 + ordemNoBanco,
    }))
    .sort((a, b) => a.posicao - b.posicao)
    .map(({ posicao, ...campo }) => campo);
}

function montarPedido(row) {
  return {
    id: row.ID,
    conversaId: row.CONVERSA_ID,
    contatoId: row.CONTATO_ID,
    titulo: row.TITULO || 'Pedido',
    campos: camposDoPayload(row.PAYLOAD),
    status: row.STATUS,
    observacao: row.OBSERVACAO || null,
    criadoEm: row.CRIADO_EM,
    conferidoEm: row.CONFERIDO_EM || null,
    conferidoPor: row.CONFERIDO_POR_NOME || null,
    contatoNome: row.NOME_INTERNO || row.NOME_COMPLETO || row.NOME_PERFIL || null,
    contatoTelefone: row.TELEFONE || null,
    protocolo: row.PROTOCOLO || null,
  };
}

const POR_PAGINA = 30;
const POR_PAGINA_MAX = 100;

// GET / — ?status=rascunho|conferido|descartado|todos (default rascunho)
//         ?conversaId= (badge/atalho a partir da conversa)
//         ?antes=<id>  (cursor: próxima página)
//
// PAGINAÇÃO POR CURSOR, não offset (achado de review, P2, PR #33): a fila é
// ordenada do mais novo para o mais antigo e recebe pedido novo o tempo todo —
// com OFFSET, um pedido registrado entre uma página e outra empurra a lista e
// faz um rascunho pular a página seguinte sem nunca ser visto. `id` é IDENTITY
// (monotônico), então ordenar por ele é a mesma coisa que por `criado_em` e o
// cursor "tudo com id menor que este" é exato.
//
// O corte anterior era um LIMIT sem continuação: num tenant movimentado, os
// rascunhos além do teto sumiam da fila sem ninguém resolver.
router.get('/', async (req, res, next) => {
  const statusFiltro = String(req.query.status || 'rascunho');
  const conversaId = Number(req.query.conversaId) || null;
  const antes = Number(req.query.antes) || null;
  const limite = Math.min(POR_PAGINA_MAX, Math.max(1, Number(req.query.limite) || POR_PAGINA));
  if (statusFiltro !== 'todos' && !STATUS.includes(statusFiltro)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }
  try {
    const pagina = await db.comTenant(req.tenantId, async (conn) => {
      // Pede uma linha A MAIS do que cabe na página: se ela vier, há próxima —
      // sem precisar de um COUNT(*) da fila inteira a cada rolagem.
      const binds = { tenantId: req.tenantId, limite: limite + 1 };
      let where = 'p.tenant_id = :tenantId';
      if (statusFiltro !== 'todos') { where += ' AND p.status = :status'; binds.status = statusFiltro; }
      if (conversaId) { where += ' AND p.conversa_id = :cv'; binds.cv = conversaId; }
      if (antes) { where += ' AND p.id < :antes'; binds.antes = antes; }
      where += filtroEscopo(req.perfil, binds);
      const r = await conn.execute(
        `SELECT p.id, p.conversa_id, p.contato_id, p.titulo, p.payload, p.status, p.observacao,
                p.criado_em, p.conferido_em,
                a.nome AS conferido_por_nome,
                ct.nome_interno, ct.nome_completo, ct.nome_perfil, ct.telefone,
                c.protocolo
           FROM ia_pedido p
           JOIN conversa c  ON c.tenant_id = p.tenant_id AND c.id = p.conversa_id
           LEFT JOIN contato ct  ON ct.tenant_id = p.tenant_id AND ct.id = p.contato_id
           LEFT JOIN atendente a ON a.tenant_id = p.tenant_id AND a.id = p.conferido_por
          WHERE ${where}
          ORDER BY p.id DESC
          LIMIT :limite`,
        binds);
      const linhas = r.rows || [];
      const temMais = linhas.length > limite;
      const itens = linhas.slice(0, limite).map(montarPedido);
      return { itens, proximo: temMais && itens.length ? itens[itens.length - 1].id : null };
    });
    res.json(pagina);
  } catch (err) {
    // Migração 022 pendente: lista vazia em vez de 500 (mesmo tratamento das
    // telas de IA que nasceram antes da migração delas).
    if (err.code === '42P01') return res.json({ itens: [], proximo: null });
    next(err);
  }
});

/** Conferir e descartar são a MESMA transição: rascunho → estado final, com
 *  quem/quando registrados. Só o status e o texto da nota mudam. */
async function decidir(req, res, next, { novoStatus, acao }) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const observacao = String((req.body && req.body.observacao) || '').trim().slice(0, 500) || null;
  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      const binds = { tenantId: req.tenantId, id };
      const atual = await conn.execute(
        `SELECT p.id, p.status, p.conversa_id, p.contato_id, p.titulo
           FROM ia_pedido p
           JOIN conversa c ON c.tenant_id = p.tenant_id AND c.id = p.conversa_id
          WHERE p.tenant_id = :tenantId AND p.id = :id${filtroEscopo(req.perfil, binds)}`,
        binds);
      if (!atual.rows || !atual.rows.length) return { erro: 404 };
      const pedido = atual.rows[0];
      // Guarda de corrida: dois atendentes com a lista aberta clicam quase
      // junto. O segundo tem que ver que o pedido já foi decidido, não
      // sobrescrever quem/quando do primeiro.
      if (pedido.STATUS !== 'rascunho') return { erro: 409, status: pedido.STATUS };

      const upd = await conn.execute(
        `UPDATE ia_pedido
            SET status = :novo, conferido_por = :atd, conferido_em = now(),
                observacao = COALESCE(:obs, observacao)
          WHERE tenant_id = :tenantId AND id = :id AND status = 'rascunho'`,
        { tenantId: req.tenantId, id, novo: novoStatus, atd: (req.perfil && req.perfil.atendenteId) || null, obs: observacao });
      if (!upd.rowsAffected) return { erro: 409, status: 'rascunho' };

      const quem = (req.user && req.user.nome) || 'a equipe';
      const texto = novoStatus === 'conferido'
        ? `✅ ${pedido.TITULO || 'Pedido'} conferido por ${quem}.`
        : `🗑️ ${pedido.TITULO || 'Pedido'} descartado por ${quem}${observacao ? ` — motivo: ${observacao}` : ''}.`;
      await conn.execute(
        `INSERT INTO mensagem (tenant_id, conversa_id, contato_id, direcao, tipo, conteudo, origem, ts)
         VALUES (:tenantId, :cv, :ct, 'nota', 'text', :txt, 'sistema', now())`,
        { tenantId: req.tenantId, cv: pedido.CONVERSA_ID, ct: pedido.CONTATO_ID || null, txt: texto });

      await conn.execute(
        `INSERT INTO auditoria (tenant_id, ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
         VALUES (:tenantId, :atd, :mat, :acao, 'ia_pedido', :id, :det)`,
        {
          tenantId: req.tenantId, id,
          atd: (req.perfil && req.perfil.atendenteId) || null,
          mat: (req.user && req.user.matricula) || null,
          acao, det: observacao ? JSON.stringify({ observacao }) : null,
        });

      return { conversaId: pedido.CONVERSA_ID };
    });

    if (resultado.erro === 404) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (resultado.erro === 409) {
      return res.status(409).json({ error: 'Este pedido já foi decidido por outra pessoa.' });
    }
    publish({ tipo: 'pedido', pedidoId: id, conversaId: resultado.conversaId, status: novoStatus, tenantId: req.tenantId });
    res.json({ ok: true, id, status: novoStatus });
  } catch (err) { next(err); }
}

router.post('/:id/conferir', podeAgir, (req, res, next) =>
  decidir(req, res, next, { novoStatus: 'conferido', acao: 'ia_pedido_conferido' }));

router.post('/:id/descartar', podeAgir, (req, res, next) =>
  decidir(req, res, next, { novoStatus: 'descartado', acao: 'ia_pedido_descartado' }));

module.exports = router;
