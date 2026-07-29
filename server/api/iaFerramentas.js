// api/iaFerramentas.js — o que o agente de IA PODE FAZER nesta empresa
// (FIL-85): o liga/desliga de cada ferramenta e o formulário de pedido.
//
// Fica ao lado de api/iaPerfil.js (instruções + base de conhecimento) e segue as
// mesmas regras dele: tudo atrás do add-on (`tenant.ia_habilitada`), leitura
// para ADMIN/SUPERVISOR/AUDITOR, escrita só ADMIN, escrita audita e invalida o
// cache de 60s do runtime — sem a invalidação o admin liga a ferramenta e
// continua vendo a IA sem ela por até um minuto.
//
// O CATÁLOGO NÃO ESTÁ AQUI: nome, descrição e execução de cada ferramenta vivem
// em ia/operacoes.js. Esta rota só lê e escreve o interruptor. `transferir_para
// _humano` nem aparece — é `fixa` no catálogo, porque um cliente que a IA não
// entende precisa SEMPRE ter para onde ir.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const { exigirIaHabilitada } = require('../ia/gate');
const operacoes = require('../ia/operacoes');
const pedidoTemplate = require('../ia/pedidoTemplate');
const ferramentasStore = require('../ia/ferramentasStore');

const router = express.Router();
router.use(exigirIaHabilitada);

const PODE_VER = ['ADMIN', 'SUPERVISOR', 'AUDITOR'];

async function auditar(conn, req, { acao, entidade, detalhe = null }) {
  await conn.execute(
    `INSERT INTO auditoria (tenant_id, ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, DETALHE)
     VALUES (:tenantId, :atd, :mat, :acao, :ent, :det)`,
    {
      tenantId: req.tenantId,
      atd: (req.perfil && req.perfil.atendenteId) || null,
      mat: (req.user && req.user.matricula) || null,
      acao, ent: entidade, det: detalhe ? JSON.stringify(detalhe) : null,
    }
  );
}

/** Estado das ferramentas + template, lido DIRETO do banco (sem o cache de 60s
 *  do runtime): quem acabou de salvar precisa ver o que salvou. */
async function lerEstado(conn, tenantId) {
  const f = await conn.execute(
    `SELECT NOME, ATIVO FROM ia_ferramenta WHERE tenant_id = :tenantId`, { tenantId });
  const habilitacao = {};
  for (const linha of f.rows || []) habilitacao[linha.NOME] = linha.ATIVO;

  const t = await conn.execute(
    `SELECT TITULO, CAMPOS, ATUALIZADO_EM FROM ia_pedido_template WHERE tenant_id = :tenantId`, { tenantId });
  const linha = (t.rows || [])[0] || null;
  return {
    habilitacao,
    template: linha
      ? {
        titulo: linha.TITULO,
        campos: typeof linha.CAMPOS === 'string' ? JSON.parse(linha.CAMPOS) : (linha.CAMPOS || []),
        atualizadoEm: linha.ATUALIZADO_EM || null,
      }
      : null,
  };
}

// GET / — catálogo + estado. A tela desenha a partir daqui, então manda também
// os rótulos e a ajuda de cada ferramenta (que moram no catálogo, no código).
router.get('/', exigirPapel(...PODE_VER), async (req, res, next) => {
  try {
    const estado = await db.comTenant(req.tenantId, (conn) => lerEstado(conn, req.tenantId));
    res.json({
      ferramentas: operacoes.CONFIGURAVEIS.map((op) => ({
        ...op,
        ativo: (estado.habilitacao[op.nome] || op.padrao) === 'S',
        // `registrar_pedido` ligada mas sem formulário NÃO é oferecida ao
        // modelo (ia/operacoes.js). A tela precisa dizer isso, senão o admin
        // liga o botão e fica esperando um comportamento que não vem.
        exigeTemplate: op.nome === 'registrar_pedido',
      })),
      template: estado.template,
      limites: pedidoTemplate.LIMITES,
      tipos: pedidoTemplate.TIPOS,
    });
  } catch (err) {
    // Ambiente com a migração 022 pendente: tela com os defaults do catálogo em
    // vez de 500 (mesmo tratamento do GET /api/ia-perfil na 020).
    if (err.code === '42P01') {
      return res.json({
        ferramentas: operacoes.CONFIGURAVEIS.map((op) => ({
          ...op, ativo: op.padrao === 'S', exigeTemplate: op.nome === 'registrar_pedido',
        })),
        template: null, limites: pedidoTemplate.LIMITES, tipos: pedidoTemplate.TIPOS,
      });
    }
    next(err);
  }
});

// PUT /template — o formulário de pedido da empresa (um por empresa na v1).
router.put('/template', exigirPapel('ADMIN'), async (req, res, next) => {
  const { template, erro } = pedidoTemplate.normalizarTemplate(req.body || {});
  if (erro) return res.status(400).json({ error: erro });
  try {
    await db.comTenant(req.tenantId, async (conn) => {
      await conn.execute(
        `INSERT INTO ia_pedido_template (tenant_id, TITULO, CAMPOS, ATUALIZADO_POR, ATUALIZADO_EM)
         VALUES (:tenantId, :titulo, :campos::jsonb, :atd, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           TITULO = EXCLUDED.TITULO, CAMPOS = EXCLUDED.CAMPOS,
           ATUALIZADO_POR = EXCLUDED.ATUALIZADO_POR, ATUALIZADO_EM = now()`,
        {
          tenantId: req.tenantId, titulo: template.titulo, campos: JSON.stringify(template.campos),
          atd: (req.perfil && req.perfil.atendenteId) || null,
        });
      await auditar(conn, req, {
        acao: 'ia_pedido_template_salvo', entidade: 'ia_pedido_template',
        detalhe: { titulo: template.titulo, campos: template.campos.map((c) => c.nome) },
      });
    });
    ferramentasStore.invalidar(req.tenantId);
    res.json({ ok: true, template });
  } catch (err) { next(err); }
});

// DELETE /template — sem formulário, `registrar_pedido` deixa de ser oferecida
// ao modelo, mesmo ligada. Pedidos JÁ registrados não são tocados: eles guardam
// a própria cópia dos rótulos (é para isso que a cópia existe).
router.delete('/template', exigirPapel('ADMIN'), async (req, res, next) => {
  try {
    await db.comTenant(req.tenantId, async (conn) => {
      await conn.execute(`DELETE FROM ia_pedido_template WHERE tenant_id = :tenantId`, { tenantId: req.tenantId });
      await auditar(conn, req, { acao: 'ia_pedido_template_removido', entidade: 'ia_pedido_template' });
    });
    ferramentasStore.invalidar(req.tenantId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /:nome — liga/desliga uma ferramenta do catálogo.
router.put('/:nome', exigirPapel('ADMIN'), async (req, res, next) => {
  const nome = String(req.params.nome || '');
  // Lista branca do catálogo: nome fora dele não vira linha no banco (nem uma
  // ferramenta `fixa`, que não é configurável).
  if (!operacoes.CONFIGURAVEIS.some((op) => op.nome === nome)) {
    return res.status(404).json({ error: 'Ferramenta desconhecida.' });
  }
  const body = req.body || {};
  const ativo = body.ativo === true || body.ativo === 'S' ? 'S' : 'N';
  try {
    await db.comTenant(req.tenantId, async (conn) => {
      await conn.execute(
        `INSERT INTO ia_ferramenta (tenant_id, NOME, ATIVO, ATUALIZADO_EM)
         VALUES (:tenantId, :nome, :ativo, now())
         ON CONFLICT (tenant_id, nome) DO UPDATE SET ATIVO = EXCLUDED.ATIVO, ATUALIZADO_EM = now()`,
        { tenantId: req.tenantId, nome, ativo });
      await auditar(conn, req, { acao: 'ia_ferramenta_toggle', entidade: 'ia_ferramenta', detalhe: { nome, ativo } });
    });
    ferramentasStore.invalidar(req.tenantId);
    res.json({ ok: true, nome, ativo: ativo === 'S' });
  } catch (err) { next(err); }
});

module.exports = router;
