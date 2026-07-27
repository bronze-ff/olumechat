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

const router = express.Router();

// GET /api/numeros/:id/meta-status — consulta nome/qualidade/verificação direto
// na Meta (read-only). A chamada SAI DO SERVIDOR (que tem acesso liberado à
// Graph API) — útil quando o navegador/máquina do admin não alcança a Meta.
router.get('/:id/meta-status', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res) => {
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
router.post('/:id/registrar', exigirPapel('ADMIN'), async (req, res) => {
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

// GET /api/numeros — lista (ADMIN/SUPERVISOR).
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT n.id, n.phone_number_id, n.display_phone, n.nome_exibicao,
                n.departamento_padrao_id, n.codfilial, n.quality_rating,
                n.messaging_tier, n.limite_diario, n.permite_ativo, n.modo, n.ativo, n.criado_em,
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

// POST /api/numeros — pré-cadastro manual { phoneNumberId, displayPhone?, ... } (ADMIN).
router.post('/', exigirPapel('ADMIN'), async (req, res, next) => {
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

// PUT /api/numeros/:id — { nomeExibicao?, departamentoPadraoId?, codfilial?, ativo?, modo? } (ADMIN).
// modo='ia' liga o bot de IA nesse número (só telefones autorizados respondidos;
// não-autorizados = fail-closed). 'padrao' = fluxo determinístico / inbox humano.
router.put('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};

  try {
    const encontrado = await db.comTenant(req.tenantId, async (conn) => {
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
      if (!upd.rowsAffected) return false;

      // Sair do modo IA não migra sozinho as conversas que já estavam abertas
      // nesse status (fila_status é gravado por conversa na criação, não é lido
      // do número a cada mensagem — ver webhook/processEvent.js). Sem este
      // cascade, quem testou a IA e depois voltou o número pro padrão continua
      // preso na resposta "canal restrito" para sempre nessas conversas antigas.
      if (b.modo === 'padrao') {
        const fx = await conn.execute(
          `SELECT n.departamento_padrao_id AS dep, f.id AS fluxo_id
             FROM numero n
             LEFT JOIN fluxo f ON f.numero_id = n.id AND f.ativo = 'S'
            WHERE n.id = :id`,
          { id }
        );
        const dep = (fx.rows[0] && fx.rows[0].DEP) || null;
        const fluxoId = (fx.rows[0] && fx.rows[0].FLUXO_ID) || null;
        const novoStatus = fluxoId ? 'bot' : (dep ? 'aguardando' : 'em_atendimento');
        await conn.execute(
          `UPDATE conversa
              SET fila_status = :st,
                  bot_fluxo_id = :flx,
                  departamento_id = :dep,
                  fila_entrou_em = CASE WHEN :dep IS NOT NULL THEN now() ELSE fila_entrou_em END,
                  bot_ultima_interacao = CASE WHEN :flx IS NOT NULL THEN now() ELSE bot_ultima_interacao END
            WHERE numero_id = :id AND fila_status = 'ia' AND status = 'aberta'`,
          { st: novoStatus, flx: numOuNull(fluxoId), dep: numOuNull(dep), id }
        );
      }
      return true;
    });
    if (!encontrado) return res.status(404).json({ error: 'Número não encontrado' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'Departamento inexistente' });
    next(err);
  }
});

module.exports = router;
