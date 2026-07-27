// api/numeros.js — Gestão dos números WhatsApp (Fase 5A).
// A linha em MC_ZAP_NUMERO nasce automaticamente no 1º webhook (getOrCreateNumero);
// aqui o admin complementa (nome, departamento padrão, filial) ou pré-cadastra.
// O REGISTRO do número em si continua no painel da Meta (fora do sistema).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/oracleHelper');
const { exigirPapel } = require('../auth/rbac');
const { graphGet, graphPost } = require('../graph/client');

const router = express.Router();

// GET /api/numeros/:id/meta-status — consulta nome/qualidade/verificação direto
// na Meta (read-only). A chamada SAI DO SERVIDOR (que tem acesso liberado à
// Graph API) — útil quando o navegador/máquina do admin não alcança a Meta.
router.get('/:id/meta-status', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT PHONE_NUMBER_ID FROM MC_ZAP_NUMERO WHERE ID = :id`, { id });
    if (!r.rows.length) return res.status(404).json({ error: 'Número não encontrado' });
    const pnid = r.rows[0].PHONE_NUMBER_ID;
    if (!pnid) return res.status(400).json({ error: 'Número sem Phone Number ID cadastrado.' });
    const gr = await graphGet(`${pnid}?fields=display_phone_number,verified_name,name_status,new_name_status,code_verification_status,quality_rating,status,platform_type`);
    res.json(await gr.json());
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('429')) {
      return res.status(429).json({ error: 'A Meta limitou as consultas agora (429). Tente de novo em alguns minutos.' });
    }
    res.status(502).json({ error: 'Falha ao consultar a Meta: ' + msg });
  } finally {
    if (conn) await conn.close().catch(() => {});
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
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT PHONE_NUMBER_ID FROM MC_ZAP_NUMERO WHERE ID = :id`, { id });
    if (!r.rows.length) return res.status(404).json({ error: 'Número não encontrado' });
    const pnid = r.rows[0].PHONE_NUMBER_ID;
    if (!pnid) return res.status(400).json({ error: 'Número sem Phone Number ID cadastrado.' });
    await graphPost(`${pnid}/register`, { messaging_product: 'whatsapp', pin });
    res.json({ ok: true });
  } catch (err) {
    // Repassa a mensagem real da Meta (ex.: e-mail não verificado, PIN errado) p/ o admin.
    res.status(502).json({ error: 'A Meta recusou o registro: ' + (err.message || 'erro desconhecido') });
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/numeros — lista (ADMIN/SUPERVISOR).
router.get('/', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT n.ID, n.PHONE_NUMBER_ID, n.DISPLAY_PHONE, n.NOME_EXIBICAO,
              n.DEPARTAMENTO_PADRAO_ID, n.CODFILIAL, n.QUALITY_RATING,
              n.MESSAGING_TIER, n.LIMITE_DIARIO, n.PERMITE_ATIVO, n.MODO, n.ATIVO, n.CRIADO_EM,
              d.NOME AS DEPARTAMENTO_PADRAO_NOME
         FROM MC_ZAP_NUMERO n
         LEFT JOIN MC_ZAP_DEPARTAMENTO d ON d.ID = n.DEPARTAMENTO_PADRAO_ID
        ORDER BY n.ATIVO DESC, n.ID`
    );
    res.json(mapRows(r.rows));
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/numeros/ativos — números que podem ORIGINAR conversa ativa.
// Qualquer autenticado: alimenta o seletor da "Nova conversa" (atendente com
// podeAtivo não é ADMIN/SUPERVISOR). Só devolve o mínimo necessário.
router.get('/ativos', async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT n.ID, n.DISPLAY_PHONE, n.NOME_EXIBICAO,
              n.DEPARTAMENTO_PADRAO_ID, d.NOME AS DEPARTAMENTO_PADRAO_NOME
         FROM MC_ZAP_NUMERO n
         LEFT JOIN MC_ZAP_DEPARTAMENTO d ON d.ID = n.DEPARTAMENTO_PADRAO_ID
        WHERE n.ATIVO = 'S' AND n.PERMITE_ATIVO = 'S'
        ORDER BY n.ID`
    );
    // Acesso por número: atendente restrito só vê (e envia por) os números dele.
    const meusNum = (req.perfil && req.perfil.numeroIds) || [];
    const ehAmplo = req.perfil && (req.perfil.papel === 'ADMIN' || req.perfil.papel === 'AUDITOR');
    let rows = mapRows(r.rows);
    if (!ehAmplo && meusNum.length) rows = rows.filter((n) => meusNum.includes(n.id));
    res.json(rows);
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/numeros/lista — lista enxuta (id + nome + fone) p/ o filtro de CANAL
// do inbox. Qualquer autenticado; respeita a restrição por número do atendente.
router.get('/lista', async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT ID, DISPLAY_PHONE, NOME_EXIBICAO FROM MC_ZAP_NUMERO WHERE ATIVO = 'S' ORDER BY ID`
    );
    const meusNum = (req.perfil && req.perfil.numeroIds) || [];
    const ehAmplo = req.perfil && (req.perfil.papel === 'ADMIN' || req.perfil.papel === 'AUDITOR');
    let rows = mapRows(r.rows);
    if (!ehAmplo && meusNum.length) rows = rows.filter((n) => meusNum.includes(n.id));
    res.json(rows);
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/numeros — pré-cadastro manual { phoneNumberId, displayPhone?, ... } (ADMIN).
router.post('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const phoneNumberId = String(b.phoneNumberId || '').trim();
  if (!phoneNumberId) return res.status(400).json({ error: 'phoneNumberId obrigatório (ID do número no painel Meta)' });

  let conn;
  try {
    conn = await db.getConnection();
    const { oracledb } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_NUMERO (PHONE_NUMBER_ID, DISPLAY_PHONE, NOME_EXIBICAO, DEPARTAMENTO_PADRAO_ID, CODFILIAL)
       VALUES (:p, :tel, :nome, :dep, :fil) RETURNING ID INTO :id`,
      {
        p: phoneNumberId,
        tel: b.displayPhone ? String(b.displayPhone).trim() : null,
        nome: b.nomeExibicao ? String(b.nomeExibicao).trim() : null,
        dep: b.departamentoPadraoId ? Number(b.departamentoPadraoId) : null,
        fil: b.codfilial ? Number(b.codfilial) : null,
        id: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
      }
    );
    await conn.commit();
    res.status(201).json({ id: ins.outBinds.id[0] });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err.errorNum === 1) return res.status(409).json({ error: 'Esse phoneNumberId já está cadastrado' });
    if (err.errorNum === 2291) return res.status(400).json({ error: 'Departamento inexistente' });
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// PUT /api/numeros/:id — { nomeExibicao?, departamentoPadraoId?, codfilial?, ativo?, modo? } (ADMIN).
// modo='ia' liga o bot de IA nesse número (só telefones autorizados respondidos;
// não-autorizados = fail-closed). 'padrao' = fluxo determinístico / inbox humano.
router.put('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};

  let conn;
  try {
    conn = await db.getConnection();
    const { oracledb } = db;
    // departamentoPadraoId: null explícito limpa o roteamento (volta ao inbox geral).
    const limparDep = b.departamentoPadraoId === null;
    // Binds numéricos que podem ir NULL precisam de TIPO EXPLÍCITO: null sem tipo
    // vira CHAR no driver e o COALESCE(CHAR, NUMBER) dá ORA-00932 no Oracle.
    const numOuNull = (v) => ({ type: oracledb.NUMBER, val: v });
    const upd = await conn.execute(
      `UPDATE MC_ZAP_NUMERO
          SET NOME_EXIBICAO          = COALESCE(:nome, NOME_EXIBICAO),
              DEPARTAMENTO_PADRAO_ID = ${limparDep ? 'NULL' : 'COALESCE(:dep, DEPARTAMENTO_PADRAO_ID)'},
              CODFILIAL              = COALESCE(:fil, CODFILIAL),
              LIMITE_DIARIO          = COALESCE(:lim, LIMITE_DIARIO),
              PERMITE_ATIVO          = COALESCE(:perm, PERMITE_ATIVO),
              MODO                   = COALESCE(:modo, MODO),
              ATIVO                  = COALESCE(:atv, ATIVO)
        WHERE ID = :id`,
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
    if (!upd.rowsAffected) return res.status(404).json({ error: 'Número não encontrado' });

    // Sair do modo IA não migra sozinho as conversas que já estavam abertas
    // nesse status (FILA_STATUS é gravado por conversa na criação, não é lido
    // do número a cada mensagem — ver webhook/processEvent.js). Sem este
    // cascade, quem testou a IA e depois voltou o número pro padrão continua
    // preso na resposta "canal restrito" para sempre nessas conversas antigas.
    if (b.modo === 'padrao') {
      const fx = await conn.execute(
        `SELECT n.DEPARTAMENTO_PADRAO_ID AS DEP, f.ID AS FLUXO_ID
           FROM MC_ZAP_NUMERO n
           LEFT JOIN MC_ZAP_FLUXO f ON f.NUMERO_ID = n.ID AND f.ATIVO = 'S'
          WHERE n.ID = :id`,
        { id }
      );
      const dep = (fx.rows[0] && fx.rows[0].DEP) || null;
      const fluxoId = (fx.rows[0] && fx.rows[0].FLUXO_ID) || null;
      const novoStatus = fluxoId ? 'bot' : (dep ? 'aguardando' : 'em_atendimento');
      await conn.execute(
        `UPDATE MC_ZAP_CONVERSA
            SET FILA_STATUS = :st,
                BOT_FLUXO_ID = :flx,
                DEPARTAMENTO_ID = :dep,
                FILA_ENTROU_EM = CASE WHEN :dep IS NOT NULL THEN SYSTIMESTAMP ELSE FILA_ENTROU_EM END,
                BOT_ULTIMA_INTERACAO = CASE WHEN :flx IS NOT NULL THEN SYSTIMESTAMP ELSE BOT_ULTIMA_INTERACAO END
          WHERE NUMERO_ID = :id AND FILA_STATUS = 'ia' AND STATUS = 'aberta'`,
        { st: novoStatus, flx: numOuNull(fluxoId), dep: numOuNull(dep), id }
      );
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err.errorNum === 2291) return res.status(400).json({ error: 'Departamento inexistente' });
    if (err.errorNum === 904) {
      // Coluna nova ainda não existe nesse banco (instalação desatualizada).
      return res.status(400).json({
        error: 'Coluna não encontrada no banco (' + err.message + '). Rode os scripts SQL pendentes — ex.: 10_numero_permite_ativo.sql.',
      });
    }
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
