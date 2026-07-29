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
// ESCOPO: gestor e auditor veem a carteira inteira; o atendente comum vê os
// pedidos das conversas que ele pode ver (sem departamento — que é o caso das
// conversas conduzidas pela IA —, do departamento dele, ou atribuídas a ele).
// Mesma regra da lista de conversas, para o pedido não virar porta lateral para
// dados de outro departamento.
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

/** Filtro de visibilidade por papel (ver cabeçalho). Devolve '' para quem vê tudo. */
function filtroEscopo(perfil, binds) {
  if (!perfil || ['ADMIN', 'SUPERVISOR', 'AUDITOR'].includes(perfil.papel)) return '';
  const partes = ['c.departamento_id IS NULL'];
  if (perfil.atendenteId) {
    partes.push('c.atendente_id = :escopoAtd');
    binds.escopoAtd = perfil.atendenteId;
  }
  (perfil.deptoIds || []).forEach((d, i) => { binds[`escDep${i}`] = d; });
  if ((perfil.deptoIds || []).length) {
    partes.push(`c.departamento_id IN (${perfil.deptoIds.map((_, i) => `:escDep${i}`).join(',')})`);
  }
  return ` AND (${partes.join(' OR ')})`;
}

/** payload jsonb → lista ordenada de campos para a tela. Os rótulos vêm do
 *  PAYLOAD, não do template atual: template editado depois não pode reescrever
 *  o que estava num pedido antigo (é a razão de a cópia existir). */
function camposDoPayload(bruto) {
  const payload = typeof bruto === 'string' ? JSON.parse(bruto || '{}') : (bruto || {});
  const campos = payload.campos || {};
  return Object.keys(campos).map((nome) => ({
    nome,
    rotulo: campos[nome] && campos[nome].rotulo ? campos[nome].rotulo : nome,
    tipo: (campos[nome] && campos[nome].tipo) || 'texto',
    valor: campos[nome] ? campos[nome].valor : null,
  }));
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

// GET / — ?status=rascunho|conferido|descartado|todos (default rascunho)
//         ?conversaId= (badge/atalho a partir da conversa)
router.get('/', async (req, res, next) => {
  const statusFiltro = String(req.query.status || 'rascunho');
  const conversaId = Number(req.query.conversaId) || null;
  const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 50));
  if (statusFiltro !== 'todos' && !STATUS.includes(statusFiltro)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }
  try {
    const itens = await db.comTenant(req.tenantId, async (conn) => {
      const binds = { tenantId: req.tenantId, limite };
      let where = 'p.tenant_id = :tenantId';
      if (statusFiltro !== 'todos') { where += ' AND p.status = :status'; binds.status = statusFiltro; }
      if (conversaId) { where += ' AND p.conversa_id = :cv'; binds.cv = conversaId; }
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
          ORDER BY p.criado_em DESC, p.id DESC
          LIMIT :limite`,
        binds);
      return (r.rows || []).map(montarPedido);
    });
    res.json(itens);
  } catch (err) {
    // Migração 022 pendente: lista vazia em vez de 500 (mesmo tratamento das
    // telas de IA que nasceram antes da migração delas).
    if (err.code === '42P01') return res.json([]);
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
