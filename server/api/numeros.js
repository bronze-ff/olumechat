// api/numeros.js — Gestão dos números WhatsApp (Fase 5A).
// A linha em `numero` nasce automaticamente no 1º webhook (getOrCreateNumero);
// aqui o admin complementa (nome, departamento padrão, filial) ou pré-cadastra.
// O REGISTRO do número em si continua no painel da Meta (fora do sistema).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/linhas');
const { exigirPapel } = require('../auth/rbac');
const { graphGet, graphPost } = require('../graph/client');
const handoff = require('../ia/handoff');
const { exigirIaHabilitada } = require('../ia/gate');

const router = express.Router();

/**
 * O cliente administra a operação, mas não credenciais/IDs da Meta. Cadastrar,
 * registrar e alterar um canal é uma tarefa técnica feita pelo operador dentro
 * da sessão de suporte auditada e escopada ao tenant.
 */
function exigirSuporteOperador(req, res, next) {
  if (req.user && req.user.suporte === true) return next();
  return res.status(403).json({
    error: 'O provisionamento de canais é realizado pelo operador em um acesso de suporte.',
  });
}

// GET /api/numeros/:id/meta-status — consulta nome/qualidade/verificação direto
// na Meta (read-only). A chamada SAI DO SERVIDOR (que tem acesso liberado à
// Graph API) — útil quando o navegador/máquina do admin não alcança a Meta.
router.get('/:id/meta-status', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pnid = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(`SELECT phone_number_id FROM numero WHERE id = :id`, { id });
      return r.rows.length ? (r.rows[0].PHONE_NUMBER_ID || null) : undefined;
    });
    if (pnid === undefined) return res.status(404).json({ error: 'Número não encontrado' });
    if (!pnid) return res.status(400).json({ error: 'Número sem Phone Number ID cadastrado.' });
    const gr = await graphGet(`${pnid}?fields=display_phone_number,verified_name,name_status,new_name_status,code_verification_status,quality_rating,status,platform_type`, pnid, req.tenantId);
    res.json(await gr.json());
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('429')) {
      return res.status(429).json({ error: 'A Meta limitou as consultas agora (429). Tente de novo em alguns minutos.' });
    }
    res.status(502).json({ error: 'Falha ao consultar a Meta: ' + msg });
  }
});

// POST /api/numeros/:id/registrar — registra o número no Cloud API (PENDING→CONNECTED).
// body { pin } = PIN de 6 dígitos da verificação em duas etapas. O PIN vem da UI
// e NÃO é gravado — só repassado à Meta. ADMIN apenas. É o caminho que conecta o
// número sem depender do botão "Ativar" da interface da Meta (que pode estar gateado).
router.post('/:id/registrar', exigirSuporteOperador, async (req, res) => {
  const id = Number(req.params.id);
  const pin = String((req.body && req.body.pin) || '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'O PIN precisa ter exatamente 6 dígitos.' });
  try {
    const pnid = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(`SELECT phone_number_id FROM numero WHERE id = :id`, { id });
      return r.rows.length ? (r.rows[0].PHONE_NUMBER_ID || null) : undefined;
    });
    if (pnid === undefined) return res.status(404).json({ error: 'Número não encontrado' });
    if (!pnid) return res.status(400).json({ error: 'Número sem Phone Number ID cadastrado.' });
    await graphPost(`${pnid}/register`, { messaging_product: 'whatsapp', pin }, pnid, req.tenantId);
    res.json({ ok: true });
  } catch (err) {
    // Repassa a mensagem real da Meta (ex.: e-mail não verificado, PIN errado) p/ o admin.
    res.status(502).json({ error: 'A Meta recusou o registro: ' + (err.message || 'erro desconhecido') });
  }
});

// GET /api/numeros — lista (ADMIN/SUPERVISOR/AUDITOR).
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT n.id, n.phone_number_id, n.display_phone, n.nome_exibicao,
                n.departamento_padrao_id, n.codfilial, n.quality_rating,
                n.messaging_tier, n.limite_diario, n.permite_ativo, n.modo,
                n.ia_regra, n.ia_modo_teste, n.ativo, n.criado_em,
                d.nome AS departamento_padrao_nome
           FROM numero n
           LEFT JOIN departamento d ON d.id = n.departamento_padrao_id
          ORDER BY n.ativo DESC, n.id`
      );
      return mapRows(r.rows);
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/numeros/ativos — números que podem ORIGINAR conversa ativa.
// Qualquer autenticado: alimenta o seletor da "Nova conversa" (atendente com
// podeAtivo não é ADMIN/SUPERVISOR). Só devolve o mínimo necessário.
router.get('/ativos', async (req, res, next) => {
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT n.id, n.display_phone, n.nome_exibicao,
                n.departamento_padrao_id, d.nome AS departamento_padrao_nome
           FROM numero n
           LEFT JOIN departamento d ON d.id = n.departamento_padrao_id
          WHERE n.ativo = 'S' AND n.permite_ativo = 'S'
          ORDER BY n.id`
      );
      return mapRows(r.rows);
    });
    // Acesso por número: atendente restrito só vê (e envia por) os números dele.
    const meusNum = (req.perfil && req.perfil.numeroIds) || [];
    const ehAmplo = req.perfil && (req.perfil.papel === 'ADMIN' || req.perfil.papel === 'AUDITOR');
    res.json(ehAmplo || !meusNum.length ? rows : rows.filter((n) => meusNum.includes(n.id)));
  } catch (err) {
    next(err);
  }
});

// GET /api/numeros/lista — lista enxuta (id + nome + fone) p/ o filtro de CANAL
// do inbox. Qualquer autenticado; respeita a restrição por número do atendente.
router.get('/lista', async (req, res, next) => {
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT id, display_phone, nome_exibicao FROM numero WHERE ativo = 'S' ORDER BY id`
      );
      return mapRows(r.rows);
    });
    const meusNum = (req.perfil && req.perfil.numeroIds) || [];
    const ehAmplo = req.perfil && (req.perfil.papel === 'ADMIN' || req.perfil.papel === 'AUDITOR');
    res.json(ehAmplo || !meusNum.length ? rows : rows.filter((n) => meusNum.includes(n.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/numeros — pré-cadastro manual feito pelo operador em suporte.
router.post('/', exigirSuporteOperador, async (req, res, next) => {
  const b = req.body || {};
  const phoneNumberId = String(b.phoneNumberId || '').trim();
  if (!phoneNumberId) return res.status(400).json({ error: 'phoneNumberId obrigatório (ID do número no painel Meta)' });

  try {
    const id = await db.comTenant(req.tenantId, async (conn) => {
      const ins = await conn.execute(
        `INSERT INTO numero (phone_number_id, display_phone, nome_exibicao, departamento_padrao_id, codfilial)
         VALUES (:p, :tel, :nome, :dep, :fil) RETURNING id`,
        {
          p: phoneNumberId,
          tel: b.displayPhone ? String(b.displayPhone).trim() : null,
          nome: b.nomeExibicao ? String(b.nomeExibicao).trim() : null,
          dep: b.departamentoPadraoId ? Number(b.departamentoPadraoId) : null,
          fil: b.codfilial ? Number(b.codfilial) : null,
        }
      );
      return ins.rows[0].ID;
    });
    res.status(201).json({ id });
  } catch (err) {
    // uq_num_pnid é a única unicidade GLOBAL do schema (não por tenant): o
    // webhook da Meta resolve o tenant a PARTIR do phone_number_id, então dois
    // tenants não podem reivindicar o mesmo número (ver docs/PORTE.md §1.2).
    if (err.code === '23505' && err.constraint === 'uq_num_pnid') {
      return res.status(409).json({ error: 'Esse phoneNumberId já está cadastrado' });
    }
    if (err.code === '23503') return res.status(400).json({ error: 'Departamento inexistente' });
    next(err);
  }
});

// PUT /api/numeros/:id/ia — { ativo?, regra?, modoTeste? } (ADMIN do cliente).
//
// Rota SEPARADA do PUT /:id de propósito. O cadastro técnico do canal
// (phone_number_id, filial, limite diário) continua sendo do operador em sessão
// de suporte auditada — abrir o PUT inteiro para o ADMIN entregaria isso junto.
// O que muda aqui é decisão de NEGÓCIO do cliente: ligar a IA no canal, escolher
// se ela cobre 24/7 ou só fora do expediente, e abrir ou fechar o modo teste.
//
// Achado de review (P1, PR #32): DESLIGAR não pode ficar atrás do gate do
// add-on. Se o operador desliga `tenant.ia_habilitada`, o runtime para de
// responder (fase 1) MAS as conversas continuam presas em `fila_status='ia'`;
// com o gate na frente, o admin também não conseguiria desligar o canal para
// liberá-las — o cliente ficaria sem atendimento nenhum, sem saída pela UI.
// Por isso: desligar (e SÓ desligar) passa sem o gate; ligar ou reconfigurar
// continua exigindo o add-on.
function gateIaDoCanal(req, res, next) {
  const b = req.body || {};
  const desligando = b.ativo === false || b.ativo === 'N';
  const soDesligando = desligando && b.regra === undefined && b.modoTeste === undefined;
  if (soDesligando) return next();
  return exigirIaHabilitada(req, res, next);
}

router.put('/:id/ia', exigirPapel('ADMIN'), gateIaDoCanal, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};

  // Validação ANTES de tocar o banco: valor fora do enum estouraria o CHECK da
  // migração 021 como 500, em vez de virar um 400 com mensagem clara.
  let modo = null;
  if (b.ativo !== undefined) modo = b.ativo === true || b.ativo === 'S' ? 'ia' : 'padrao';
  let regra = null;
  if (b.regra !== undefined) {
    if (!['sempre', 'fora_horario'].includes(b.regra)) {
      return res.status(400).json({ error: 'Regra inválida. Use "sempre" ou "fora_horario".' });
    }
    regra = b.regra;
  }
  let teste = null;
  if (b.modoTeste !== undefined) teste = b.modoTeste === true || b.modoTeste === 'S' ? 'S' : 'N';
  if (modo === null && regra === null && teste === null) {
    return res.status(400).json({ error: 'Nada para atualizar.' });
  }

  try {
    const { encontrado, deptoParaDistribuir } = await db.comTenant(req.tenantId, async (conn) => {
      const upd = await conn.execute(
        `UPDATE numero
            SET modo          = COALESCE(:modo, modo),
                ia_regra      = COALESCE(:regra, ia_regra),
                ia_modo_teste = COALESCE(:teste, ia_modo_teste)
          WHERE tenant_id = :tenantId AND id = :id`,
        { tenantId: req.tenantId, modo, regra, teste, id }
      );
      if (!upd.rowsAffected) return { encontrado: false, deptoParaDistribuir: null };

      // Desligar a IA precisa liberar as conversas que já estavam em
      // fila_status='ia' — é a MESMA cascata do PUT /:id (ia/handoff.js). Sem
      // ela, quem testou a IA e desligou fica preso no "canal restrito" para
      // sempre nessas conversas antigas.
      let deptoParaDistribuir = null;
      if (modo === 'padrao') {
        const destino = await handoff.resolverDestino(conn, req.tenantId, id, { permitirFluxo: true });
        const numOuNull = (v) => ({ type: db.tipos.NUMBER, val: v });
        const cascata = await conn.execute(
          `UPDATE conversa
              SET fila_status = :st,
                  bot_fluxo_id = :flx,
                  departamento_id = :dep,
                  fila_entrou_em = CASE WHEN :dep IS NOT NULL THEN now() ELSE fila_entrou_em END,
                  bot_ultima_interacao = CASE WHEN :flx IS NOT NULL THEN now() ELSE bot_ultima_interacao END
            WHERE tenant_id = :tenantId AND numero_id = :id AND fila_status = 'ia' AND status = 'aberta'`,
          { tenantId: req.tenantId, st: destino.filaStatus,
            flx: numOuNull(destino.fluxoId), dep: numOuNull(destino.departamentoId), id }
        );
        // Achado de review (P1, PR #32): a cascata joga conversas em
        // 'aguardando' e ninguém acordava o distribuidor — elas ficavam na fila
        // sem dono até o próximo boot (varrerPendentes). Mesmo padrão dos
        // outros produtores de fila: atribuir DEPOIS do commit.
        if (destino.filaStatus === 'aguardando' && destino.departamentoId && cascata.rowsAffected) {
          deptoParaDistribuir = destino.departamentoId;
        }
      }

      await conn.execute(
        `INSERT INTO auditoria (tenant_id, atendente_id, matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:tenantId, :atd, :mat, 'ia_canal_alterado', 'numero', :id, :det)`,
        { tenantId: req.tenantId, atd: (req.perfil && req.perfil.atendenteId) || null,
          mat: req.user && req.user.matricula, id,
          det: JSON.stringify({ modo, regra, modoTeste: teste }) }
      );
      return { encontrado: true, deptoParaDistribuir };
    });
    if (!encontrado) return res.status(404).json({ error: 'Número não encontrado' });
    // Pós-commit: antes disso as conversas movidas ainda não são visíveis para
    // a conexão do distribuidor.
    if (deptoParaDistribuir) require('../fila/distribuidor').atribuir(deptoParaDistribuir);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/numeros/:id — { nomeExibicao?, departamentoPadraoId?, codfilial?, ativo?, modo? } (ADMIN).
// modo='ia' liga o bot de IA nesse número (só telefones autorizados respondidos;
// não-autorizados = fail-closed). 'padrao' = fluxo determinístico / inbox humano.
router.put('/:id', exigirSuporteOperador, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};

  try {
    const { encontrado, deptoParaDistribuir } = await db.comTenant(req.tenantId, async (conn) => {
      // departamentoPadraoId: null explícito limpa o roteamento (volta ao inbox geral).
      const limparDep = b.departamentoPadraoId === null;
      const numOuNull = (v) => ({ type: db.tipos.NUMBER, val: v });
      const upd = await conn.execute(
        `UPDATE numero
            SET nome_exibicao          = COALESCE(:nome, nome_exibicao),
                departamento_padrao_id = ${limparDep ? 'NULL' : 'COALESCE(:dep, departamento_padrao_id)'},
                codfilial              = COALESCE(:fil, codfilial),
                limite_diario          = COALESCE(:lim, limite_diario),
                permite_ativo          = COALESCE(:perm, permite_ativo),
                modo                   = COALESCE(:modo, modo),
                ativo                  = COALESCE(:atv, ativo)
          WHERE id = :id`,
        {
          nome: b.nomeExibicao ? String(b.nomeExibicao).trim() : null,
          ...(limparDep ? {} : { dep: numOuNull(b.departamentoPadraoId ? Number(b.departamentoPadraoId) : null) }),
          fil: numOuNull(b.codfilial ? Number(b.codfilial) : null),
          lim: numOuNull(Number(b.limiteDiario) > 0 ? Number(b.limiteDiario) : null),
          perm: b.permiteAtivo === 'S' || b.permiteAtivo === 'N' ? b.permiteAtivo : null,
          modo: b.modo === 'padrao' || b.modo === 'ia' ? b.modo : null,
          atv: b.ativo === 'S' || b.ativo === 'N' ? b.ativo : null,
          id,
        }
      );
      if (!upd.rowsAffected) return { encontrado: false, deptoParaDistribuir: null };

      // Sair do modo IA não migra sozinho as conversas que já estavam abertas
      // nesse status (fila_status é gravado por conversa na criação, não é lido
      // do número a cada mensagem — ver webhook/processEvent.js). Sem este
      // cascade, quem testou a IA e depois voltou o número pro padrão continua
      // preso na resposta "canal restrito" para sempre nessas conversas antigas.
      // FIL-84: a cascata virou ia/handoff.resolverDestino — a MESMA usada pela
      // ferramenta transferir_para_humano e pelo botão Assumir.
      let deptoParaDistribuir = null;
      if (b.modo === 'padrao') {
        const destino = await handoff.resolverDestino(conn, req.tenantId, id, { permitirFluxo: true });
        const cascata = await conn.execute(
          `UPDATE conversa
              SET fila_status = :st,
                  bot_fluxo_id = :flx,
                  departamento_id = :dep,
                  fila_entrou_em = CASE WHEN :dep IS NOT NULL THEN now() ELSE fila_entrou_em END,
                  bot_ultima_interacao = CASE WHEN :flx IS NOT NULL THEN now() ELSE bot_ultima_interacao END
            WHERE tenant_id = :tenantId AND numero_id = :id AND fila_status = 'ia' AND status = 'aberta'`,
          { tenantId: req.tenantId, st: destino.filaStatus,
            flx: numOuNull(destino.fluxoId), dep: numOuNull(destino.departamentoId), id }
        );
        // Achado de review (P1, PR #32): ver o comentário equivalente no
        // PUT /:id/ia — sem acordar o distribuidor, a conversa liberada fica na
        // fila sem dono até o próximo boot.
        if (destino.filaStatus === 'aguardando' && destino.departamentoId && cascata.rowsAffected) {
          deptoParaDistribuir = destino.departamentoId;
        }
      }
      return { encontrado: true, deptoParaDistribuir };
    });
    if (!encontrado) return res.status(404).json({ error: 'Número não encontrado' });
    if (deptoParaDistribuir) require('../fila/distribuidor').atribuir(deptoParaDistribuir);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'Departamento inexistente' });
    next(err);
  }
});

module.exports = router;
