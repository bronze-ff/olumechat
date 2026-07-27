// api/campanhas.js — Campanha de cobrança em lote (Fase 6). ADMIN/SUPERVISOR.
// CRUD do rascunho + preview (read-only) + preparar (materializa destinatários)
// + disparar/pausar/retomar + progresso + itens (comprovante).
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/oracleHelper');
const { exigirPapel } = require('../auth/rbac');
const { codificar, decodificar, jsonAscii } = require('../utils/texto');
const { normalizar, variantes } = require('../utils/telefone');
const segmento = require('../campanha/segmento');
const dispatcher = require('../campanha/dispatcher');

const router = express.Router();
// Campanha é disparo PAGO em massa e o comprovante expõe PII de clientes (nome,
// telefone, custo) entre departamentos. Sem escopo por depto no schema, fica
// restrita a ADMIN — evita um SUPERVISOR ler/disparar/exportar campanha alheia.
router.use(exigirPapel('ADMIN'));

async function lerClob(v) { return v == null ? null : (typeof v === 'string' ? v : v.getData()); }

/** Lê o SEGMENTO (CLOB JSON) da campanha: { sql, telefoneCol, variaveis:[col...] }. */
function parseSegmento(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

// GET /api/campanhas — lista.
router.get('/', async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT c.ID, c.NOME, c.STATUS, c.TEMPLATE_NOME, c.TOTAL, c.ENVIADOS, c.PAUSA_MOTIVO,
              c.CRIADO_EM, c.NUMERO_ID, n.DISPLAY_PHONE, n.NOME_EXIBICAO
         FROM MC_ZAP_CAMPANHA c LEFT JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
        ORDER BY c.ID DESC`
    );
    res.json(mapRows(r.rows).map((c) => ({ ...c, nome: decodificar(c.nome) })));
  } catch (err) { next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

// GET /api/campanhas/:id — detalhe + progresso.
router.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT ID, NOME, STATUS, NUMERO_ID, TEMPLATE_NOME, LANG, SEGMENTO, TOTAL, ENVIADOS,
              RATE_POR_SEG, JANELA_INICIO, JANELA_FIM, PAUSA_MOTIVO, AGENDAMENTO
         FROM MC_ZAP_CAMPANHA WHERE ID = :id`, { id });
    if (!r.rows.length) return res.status(404).json({ error: 'Campanha não encontrada' });
    const row = r.rows[0];
    res.json({
      id: row.ID, nome: decodificar(row.NOME), status: row.STATUS, numeroId: row.NUMERO_ID,
      templateNome: row.TEMPLATE_NOME, lang: row.LANG, segmento: parseSegmento(await lerClob(row.SEGMENTO)),
      total: row.TOTAL, enviados: row.ENVIADOS, ratePorSeg: row.RATE_POR_SEG,
      janelaInicio: row.JANELA_INICIO, janelaFim: row.JANELA_FIM, pausaMotivo: row.PAUSA_MOTIVO,
    });
  } catch (err) { next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

function validarCorpo(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) return { erro: 'Dê um nome à campanha.' };
  const seg = b.segmento || {};
  if (!seg.sql) return { erro: 'Escreva o SELECT do segmento.' };
  if (!seg.telefoneCol) return { erro: 'Indique a coluna do telefone.' };
  try { segmento.validarSql(seg.sql); } catch (e) { return { erro: e.message }; }
  return { nome, seg };
}

// POST /api/campanhas — cria rascunho.
router.post('/', async (req, res, next) => {
  const b = req.body || {};
  const v = validarCorpo(b);
  if (v.erro) return res.status(400).json({ error: v.erro });
  let conn;
  try {
    conn = await db.getConnection();
    const { oracledb } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_CAMPANHA
         (NOME, NUMERO_ID, TEMPLATE_NOME, LANG, SEGMENTO, RATE_POR_SEG, JANELA_INICIO, JANELA_FIM, CRIADO_POR)
       VALUES (:nome, :num, :tpl, :lang, :seg, :rate, :ji, :jf, :atd) RETURNING ID INTO :id`,
      {
        nome: codificar(v.nome), num: b.numeroId ? Number(b.numeroId) : null,
        tpl: b.templateNome || null, lang: b.lang || 'pt_BR', seg: jsonAscii(v.seg),
        rate: Number(b.ratePorSeg) || 10, ji: b.janelaInicio || '08:00', jf: b.janelaFim || '20:00',
        atd: (req.perfil && req.perfil.atendenteId) || null, // trilha de autoria
        id: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
      }
    );
    await conn.commit();
    res.status(201).json({ id: ins.outBinds.id[0] });
  } catch (err) { if (conn) await conn.rollback().catch(() => {}); next(err); }
  finally { if (conn) await conn.close().catch(() => {}); }
});

// PUT /api/campanhas/:id — edita rascunho.
router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const v = validarCorpo(b);
  if (v.erro) return res.status(400).json({ error: v.erro });
  let conn;
  try {
    conn = await db.getConnection();
    const st = await conn.execute(`SELECT STATUS FROM MC_ZAP_CAMPANHA WHERE ID = :id`, { id });
    if (!st.rows.length) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (!['rascunho', 'pausada'].includes(st.rows[0].STATUS)) {
      return res.status(409).json({ error: 'Só dá para editar campanha em rascunho ou pausada.' });
    }
    await conn.execute(
      `UPDATE MC_ZAP_CAMPANHA
          SET NOME = :nome, NUMERO_ID = :num, TEMPLATE_NOME = :tpl, LANG = :lang, SEGMENTO = :seg,
              RATE_POR_SEG = :rate, JANELA_INICIO = :ji, JANELA_FIM = :jf, ATUALIZADO_EM = SYSTIMESTAMP
        WHERE ID = :id`,
      {
        nome: codificar(v.nome), num: b.numeroId ? Number(b.numeroId) : null,
        tpl: b.templateNome || null, lang: b.lang || 'pt_BR', seg: jsonAscii(v.seg),
        rate: Number(b.ratePorSeg) || 10, ji: b.janelaInicio || '08:00', jf: b.janelaFim || '20:00', id,
      }
    );
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { if (conn) await conn.rollback().catch(() => {}); next(err); }
  finally { if (conn) await conn.close().catch(() => {}); }
});

const CUSTO_ESTIMADO = 0.04; // R$/msg utility (alinhe ao dispatcher)

// POST /api/campanhas/:id/preview — amostra + total + custo (NÃO materializa).
router.post('/:id/preview', async (req, res, next) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT SEGMENTO FROM MC_ZAP_CAMPANHA WHERE ID = :id`, { id });
    if (!r.rows.length) return res.status(404).json({ error: 'Campanha não encontrada' });
    const seg = parseSegmento(await lerClob(r.rows[0].SEGMENTO));
    const amostra = await segmento.rodarPreview(conn, seg.sql, {}, 50);
    const total = await segmento.contarTotal(conn, seg.sql, {});
    const avisos = [];
    if (!amostra.length) avisos.push('O SELECT não retornou nenhuma linha.');
    else if (!(seg.telefoneCol in amostra[0])) avisos.push(`A coluna de telefone "${seg.telefoneCol}" não está no resultado.`);
    res.json({ amostra, colunas: amostra.length ? Object.keys(amostra[0]) : [], total, custoEstimado: total * CUSTO_ESTIMADO, avisos });
  } catch (err) {
    // Erro de SQL (ex.: ORA-00942 falta GRANT) volta cru pra o DBA enxergar.
    res.status(400).json({ error: 'Erro ao rodar o SELECT: ' + err.message });
  } finally { if (conn) await conn.close().catch(() => {}); }
});

// POST /api/campanhas/:id/preparar — materializa destinatários (dedup + opt-out).
router.post('/:id/preparar', async (req, res, next) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT STATUS, SEGMENTO FROM MC_ZAP_CAMPANHA WHERE ID = :id`, { id });
    if (!r.rows.length) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (!['rascunho', 'pausada'].includes(r.rows[0].STATUS)) {
      return res.status(409).json({ error: 'Só dá para preparar campanha em rascunho.' });
    }
    const seg = parseSegmento(await lerClob(r.rows[0].SEGMENTO));
    const linhas = await segmento.rodarCompleto(conn, seg.sql, {});

    // Limpa itens anteriores (re-preparar) e re-insere.
    await conn.execute(`DELETE FROM MC_ZAP_CAMPANHA_ITEM WHERE CAMPANHA_ID = :id`, { id });

    let inseridos = 0, invalidos = 0, duplicados = 0;
    const exemplosInvalidos = []; // amostra crua p/ o DBA ver O QUE veio errado (ex.: sem DDD)
    const vistos = new Set();
    for (const linha of linhas) {
      const bruto = linha[seg.telefoneCol];
      const tel = normalizar(bruto);
      if (tel.length < 12) {
        invalidos++;
        if (exemplosInvalidos.length < 5) exemplosInvalidos.push(String(bruto ?? '(vazio)'));
        continue;
      }
      // Chave canônica: as variantes (com/sem 9) ordenadas → idêntica pras duas
      // formas do mesmo número, garantindo dedup mesmo se vier dos dois jeitos.
      const chave = variantes(tel).slice().sort().join('|');
      if (vistos.has(chave)) { duplicados++; continue; }
      vistos.add(chave);
      const vars = (seg.variaveis || []).map((col) => String(linha[col] ?? ''));
      try {
        await conn.execute(
          `INSERT INTO MC_ZAP_CAMPANHA_ITEM (CAMPANHA_ID, TELEFONE, VARIAVEIS, STATUS)
           VALUES (:cid, :tel, :vars, 'pendente')`,
          { cid: id, tel, vars: jsonAscii(vars) }
        );
        inseridos++;
      } catch (e) {
        if (e.errorNum === 1) { duplicados++; } else throw e; // UNIQUE (campanha,telefone)
      }
    }
    const pulados = invalidos + duplicados;
    await conn.execute(
      `UPDATE MC_ZAP_CAMPANHA SET TOTAL = :t, ENVIADOS = 0, STATUS = 'rascunho', ATUALIZADO_EM = SYSTIMESTAMP
        WHERE ID = :id`, { t: inseridos, id });
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:m, 'campanha_preparar', 'campanha', :id, :det)`,
      { m: req.user && req.user.matricula, id, det: JSON.stringify({ inseridos, invalidos, duplicados }) }
    );
    await conn.commit();
    res.json({ inseridos, pulados, invalidos, duplicados, exemplosInvalidos, total: inseridos });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(400).json({ error: 'Falha ao preparar: ' + err.message });
  } finally { if (conn) await conn.close().catch(() => {}); }
});

// POST /api/campanhas/:id/disparar — inicia o dispatcher.
router.post('/:id/disparar', async (req, res, next) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT c.STATUS, c.TOTAL, c.TEMPLATE_NOME, c.NUMERO_ID,
              (SELECT COUNT(*) FROM MC_ZAP_FLUXO f WHERE f.NUMERO_ID = c.NUMERO_ID AND f.ATIVO = 'S') AS TEM_FLUXO,
              (SELECT n.PERMITE_ATIVO FROM MC_ZAP_NUMERO n WHERE n.ID = c.NUMERO_ID) AS PERMITE_ATIVO
         FROM MC_ZAP_CAMPANHA c WHERE c.ID = :id`, { id });
    if (!r.rows.length) return res.status(404).json({ error: 'Campanha não encontrada' });
    const c = r.rows[0];
    if (!['rascunho', 'pausada'].includes(c.STATUS)) return res.status(409).json({ error: 'Campanha não está pronta para disparar.' });
    if (!c.TOTAL) return res.status(409).json({ error: 'Prepare os destinatários antes de disparar.' });
    if (!c.TEMPLATE_NOME) return res.status(400).json({ error: 'Selecione o template.' });
    if (!c.NUMERO_ID) return res.status(400).json({ error: 'Selecione o número de origem.' });
    if (c.PERMITE_ATIVO === 'N') {
      return res.status(409).json({ error: 'Esse número não permite disparo ativo. Habilite em Admin → Números ou escolha outro número.' });
    }

    const avisos = [];
    if (Number(c.TEM_FLUXO) > 0) avisos.push('Atenção: esse número tem um fluxo (bot) ativo — as respostas dos clientes vão cair no bot, não na fila. Para cobrança, use um número sem fluxo, com departamento padrão = Cobrança.');

    await conn.execute(
      `UPDATE MC_ZAP_CAMPANHA SET STATUS = 'enviando', PAUSA_MOTIVO = NULL, RETOMA_EM = NULL,
              ATUALIZADO_EM = SYSTIMESTAMP WHERE ID = :id`, { id });
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID)
       VALUES (:m, 'campanha_disparar', 'campanha', :id)`, { m: req.user && req.user.matricula, id });
    await conn.commit();
    dispatcher.acordar(id);
    res.json({ ok: true, avisos });
  } catch (err) { if (conn) await conn.rollback().catch(() => {}); next(err); }
  finally { if (conn) await conn.close().catch(() => {}); }
});

// POST /:id/pausar e /:id/retomar
router.post('/:id/pausar', async (req, res, next) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await db.getConnection();
    await conn.execute(
      `UPDATE MC_ZAP_CAMPANHA SET STATUS = 'pausada', PAUSA_MOTIVO = 'pausada manualmente', RETOMA_EM = NULL
        WHERE ID = :id AND STATUS = 'enviando'`, { id });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

router.post('/:id/retomar', async (req, res, next) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await db.getConnection();
    await conn.execute(
      `UPDATE MC_ZAP_CAMPANHA SET STATUS = 'enviando', PAUSA_MOTIVO = NULL, RETOMA_EM = NULL
        WHERE ID = :id AND STATUS = 'pausada'`, { id });
    await conn.commit();
    dispatcher.acordar(id);
    res.json({ ok: true });
  } catch (err) { next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

// GET /:id/progresso — contagem por status + custo.
router.get('/:id/progresso', async (req, res, next) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(
      `SELECT STATUS, COUNT(*) AS QTD, NVL(SUM(CUSTO),0) AS CUSTO
         FROM MC_ZAP_CAMPANHA_ITEM WHERE CAMPANHA_ID = :id GROUP BY STATUS`, { id });
    const porStatus = {}; let custo = 0;
    for (const row of r.rows) { porStatus[row.STATUS] = Number(row.QTD); custo += Number(row.CUSTO); }
    const camp = await conn.execute(`SELECT STATUS, TOTAL, ENVIADOS, PAUSA_MOTIVO FROM MC_ZAP_CAMPANHA WHERE ID = :id`, { id });
    res.json({ porStatus, custo, campanha: camp.rows.length ? mapRows(camp.rows)[0] : null });
  } catch (err) { next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

// GET /:id/itens — comprovante por destinatário (paginado).
const POR_PAGINA = 30;
router.get('/:id/itens', async (req, res, next) => {
  const id = Number(req.params.id);
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const status = String(req.query.status || '').trim();
  const q = String(req.query.q || '').replace(/\D/g, '');
  let conn;
  try {
    conn = await db.getConnection();
    const binds = { id };
    let filtro = 'WHERE i.CAMPANHA_ID = :id';
    if (['pendente', 'enviado', 'entregue', 'lido', 'falha', 'optout'].includes(status)) { filtro += ' AND i.STATUS = :st'; binds.st = status; }
    if (q) { filtro += ' AND i.TELEFONE LIKE \'%\'||:q||\'%\''; binds.q = q; }
    const total = await conn.execute(`SELECT COUNT(*) AS QTD FROM MC_ZAP_CAMPANHA_ITEM i ${filtro}`, binds);
    const rows = await conn.execute(
      `SELECT i.ID, i.TELEFONE, i.STATUS, i.ERRO_CODIGO, i.ENVIADO_EM, i.CUSTO, ct.NOME_PERFIL
         FROM MC_ZAP_CAMPANHA_ITEM i LEFT JOIN MC_ZAP_CONTATO ct ON ct.ID = i.CONTATO_ID
        ${filtro} ORDER BY i.ID OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      { ...binds, off: (pagina - 1) * POR_PAGINA, lim: POR_PAGINA });
    res.json({
      total: total.rows[0].QTD, pagina, porPagina: POR_PAGINA,
      itens: mapRows(rows.rows).map((r) => ({ ...r, nomePerfil: decodificar(r.nomePerfil) })),
    });
  } catch (err) { next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const ROTULO_STATUS = { pendente: 'pendente', enviado: 'enviado', entregue: 'entregue', lido: 'lido', falha: 'falha', optout: 'opt-out' };

// GET /:id/itens/export.csv — comprovante completo (download auditado p/ o financeiro).
router.get('/:id/itens/export.csv', async (req, res, next) => {
  const id = Number(req.params.id);
  const status = String(req.query.status || '').trim();
  const q = String(req.query.q || '').replace(/\D/g, '');
  let conn;
  try {
    conn = await db.getConnection();
    const binds = { id };
    let filtro = 'WHERE i.CAMPANHA_ID = :id';
    if (['pendente', 'enviado', 'entregue', 'lido', 'falha', 'optout'].includes(status)) { filtro += ' AND i.STATUS = :st'; binds.st = status; }
    if (q) { filtro += ' AND i.TELEFONE LIKE \'%\'||:q||\'%\''; binds.q = q; }
    const camp = await conn.execute(`SELECT NOME FROM MC_ZAP_CAMPANHA WHERE ID = :id`, { id });
    if (!camp.rows.length) return res.status(404).json({ error: 'Campanha não encontrada' });
    const rows = await conn.execute(
      `SELECT i.TELEFONE, i.STATUS, i.ERRO_CODIGO, i.ENVIADO_EM, i.CUSTO, ct.NOME_PERFIL
         FROM MC_ZAP_CAMPANHA_ITEM i LEFT JOIN MC_ZAP_CONTATO ct ON ct.ID = i.CONTATO_ID
        ${filtro} ORDER BY i.ID`, binds);
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:m, 'export_csv', 'campanha', :id, :det)`,
      { m: req.user && req.user.matricula, id, det: JSON.stringify({ filtros: { status, q }, linhas: rows.rows.length }) });
    await conn.commit();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="comprovante-campanha-${id}.csv"`);
    const cab = ['Cliente', 'Telefone', 'Status', 'Cod. erro', 'Enviado em', 'Custo (R$)'];
    const linhas = [cab.join(';')];
    for (const r of rows.rows) {
      linhas.push([
        decodificar(r.NOME_PERFIL), r.TELEFONE, ROTULO_STATUS[r.STATUS] || r.STATUS, r.ERRO_CODIGO,
        r.ENVIADO_EM ? new Date(r.ENVIADO_EM).toLocaleString('pt-BR') : '',
        r.CUSTO != null ? Number(r.CUSTO).toFixed(2).replace('.', ',') : '',
      ].map(csvEscape).join(';'));
    }
    res.send('﻿' + linhas.join('\r\n')); // BOM p/ Excel abrir com acentos
  } catch (err) { next(err); } finally { if (conn) await conn.close().catch(() => {}); }
});

// DELETE /:id — apaga rascunho.
router.delete('/:id', exigirPapel('ADMIN'), async (req, res, next) => {
  const id = Number(req.params.id);
  let conn;
  try {
    conn = await db.getConnection();
    const st = await conn.execute(`SELECT STATUS FROM MC_ZAP_CAMPANHA WHERE ID = :id`, { id });
    if (!st.rows.length) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (st.rows[0].STATUS === 'enviando') return res.status(409).json({ error: 'Pause antes de apagar.' });
    await conn.execute(`DELETE FROM MC_ZAP_CAMPANHA_ITEM WHERE CAMPANHA_ID = :id`, { id });
    await conn.execute(`DELETE FROM MC_ZAP_CAMPANHA WHERE ID = :id`, { id });
    await conn.commit();
    res.json({ ok: true });
  } catch (err) { if (conn) await conn.rollback().catch(() => {}); next(err); }
  finally { if (conn) await conn.close().catch(() => {}); }
});

module.exports = router;
