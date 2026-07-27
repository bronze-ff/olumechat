// api/contatos.js — Ficha do contato: identificação interna + vínculo WinThor.
//
// O contato chega com o NOME_PERFIL do WhatsApp (ex.: "somente wattzap"). Aqui a
// gente grava NO CONTATO (vale para todas as conversas daquele telefone): nome
// interno/apelido, CNPJ, vínculo CODCLI, observações e tags. Também serve o
// mini-painel de cobrança (títulos em aberto do WinThor) e a "sugestão" de
// cliente pelo telefone para contatos antigos ainda não identificados.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { mapRows } = require('../utils/oracleHelper');
const { codificar, decodificar } = require('../utils/texto');
const { acharClientePorTelefone, dadosClienteWinthor } = require('../utils/clienteLookup');
const { publish } = require('../realtime/hub');

const router = express.Router();

/** Bloqueia AUDITOR (somente-leitura) nas mutações. */
function naoAuditor(req, res, next) {
  if (req.perfil && req.perfil.papel === 'AUDITOR') {
    return res.status(403).json({ error: 'Perfil somente-leitura (AUDITOR) não pode executar esta ação.' });
  }
  next();
}

/**
 * Escopo do contato: ADMIN/AUDITOR veem todos; os demais só veem um contato se
 * tiverem ao menos UMA conversa dele dentro do próprio escopo (mesma regra da
 * lista de conversas). Devolve a linha do contato ou null (404).
 */
async function contatoNoEscopo(conn, id, perfil) {
  const r = await conn.execute(
    `SELECT ct.ID, ct.TELEFONE, ct.NOME_PERFIL, ct.NOME_INTERNO, ct.CODCLI, ct.CGCENT,
            ct.OBSERVACOES, ct.TAGS_CONTATO, ct.ATUALIZADO_EM,
            a.NOME AS ATUALIZADO_POR_NOME
       FROM MC_ZAP_CONTATO ct
       LEFT JOIN MC_ZAP_ATENDENTE a ON a.ID = ct.ATUALIZADO_POR
      WHERE ct.ID = :id`,
    { id }
  );
  if (!r.rows.length) return null;
  if (!perfil || perfil.papel === 'ADMIN' || perfil.papel === 'AUDITOR') return r.rows[0];

  // Existe alguma conversa deste contato no escopo do atendente?
  const binds = { id };
  const partes = ['c.DEPARTAMENTO_ID IS NULL'];
  if (perfil.atendenteId) { partes.push('c.ATENDENTE_ID = :atd'); binds.atd = perfil.atendenteId; }
  (perfil.deptoIds || []).forEach((d, i) => { binds['d' + i] = d; });
  if ((perfil.deptoIds || []).length) {
    partes.push(`c.DEPARTAMENTO_ID IN (${perfil.deptoIds.map((_, i) => ':d' + i).join(',')})`);
  }
  let numFiltro = '';
  if ((perfil.numeroIds || []).length) {
    perfil.numeroIds.forEach((n, i) => { binds['n' + i] = n; });
    const ns = perfil.numeroIds.map((_, i) => ':n' + i).join(',');
    numFiltro = ` AND (c.NUMERO_ID IS NULL OR c.NUMERO_ID IN (${ns})${perfil.atendenteId ? ' OR c.ATENDENTE_ID = :atd' : ''})`;
  }
  const ok = await conn.execute(
    `SELECT 1 FROM MC_ZAP_CONVERSA c
      WHERE c.CONTATO_ID = :id AND (${partes.join(' OR ')})${numFiltro}
      FETCH FIRST 1 ROWS ONLY`,
    binds
  );
  return ok.rows.length ? r.rows[0] : null;
}

function montarFicha(row) {
  return {
    id: row.ID,
    telefone: row.TELEFONE,
    nomePerfil: decodificar(row.NOME_PERFIL),
    nomeInterno: decodificar(row.NOME_INTERNO),
    codcli: row.CODCLI || null,
    cgcent: row.CGCENT || null,
    observacoes: decodificar(row.OBSERVACOES),
    tags: row.TAGS_CONTATO ? JSON.parse(row.TAGS_CONTATO) : [],
    atualizadoPor: row.ATUALIZADO_POR_NOME || null,
    atualizadoEm: row.ATUALIZADO_EM || null,
  };
}

// GET /api/contatos/:id — ficha do contato. Se ainda não tem CODCLI, tenta uma
// SUGESTÃO de cliente pelo telefone (pra identificar contatos antigos sem mexer).
router.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const row = await contatoNoEscopo(conn, id, req.perfil);
    if (!row) return res.status(404).json({ error: 'Contato não encontrado' });
    const ficha = montarFicha(row);
    if (ficha.codcli) {
      // Dados do cliente no WinThor (vendedor/supervisor/telefones) — best-effort.
      ficha.winthor = await dadosClienteWinthor(conn, ficha.codcli);
    } else {
      const sug = await acharClientePorTelefone(conn, row.TELEFONE);
      if (sug) ficha.sugestao = { codcli: sug.codcli, nome: sug.nome, cgcent: sug.cgcent };
    }
    res.json(ficha);
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// PUT /api/contatos/:id — salva a ficha { nomeInterno?, observacoes?, cgcent?, codcli?, tags? }.
router.put('/:id', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};
  const nomeInterno = b.nomeInterno != null ? String(b.nomeInterno).trim().slice(0, 200) : null;
  const observacoes = b.observacoes != null ? String(b.observacoes).trim().slice(0, 2000) : null;
  const cgcent = b.cgcent != null ? String(b.cgcent).replace(/\D/g, '').slice(0, 20) || null : null;
  const codcli = b.codcli != null && b.codcli !== '' ? Number(b.codcli) : null;
  if (codcli != null && !Number.isInteger(codcli)) return res.status(400).json({ error: 'CODCLI inválido' });
  const tags = Array.isArray(b.tags) ? b.tags.map(Number).filter(Number.isInteger) : [];

  let conn;
  try {
    conn = await db.getConnection();
    const { oracledb } = db;
    if (!(await contatoNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }
    await conn.execute(
      // Atribuição direta (não COALESCE): o formulário SEMPRE manda o valor
      // atual, então limpar um campo (ex.: "desvincular" o CODCLI) precisa
      // persistir como NULL. Binds numéricos/string vão com tipo explícito para
      // o NULL não virar CHAR e quebrar o Oracle (ORA-00932).
      `UPDATE MC_ZAP_CONTATO
          SET NOME_INTERNO  = :ni,
              OBSERVACOES   = :obs,
              CGCENT        = :cgc,
              CODCLI        = :cod,
              TAGS_CONTATO  = :tags,
              ATUALIZADO_POR = :atd,
              ATUALIZADO_EM  = SYSTIMESTAMP
        WHERE ID = :id`,
      {
        ni: codificar(nomeInterno),
        obs: codificar(observacoes),
        cgc: { type: oracledb.STRING, val: cgcent },
        cod: { type: oracledb.NUMBER, val: codcli },
        tags: tags.length ? JSON.stringify(tags) : null,
        atd: req.perfil ? req.perfil.atendenteId : null,
        id,
      }
    );
    // Trilha "editado por/em".
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:atd, :m, 'edicao_contato', 'contato', :id, :det)`,
      {
        atd: req.perfil ? req.perfil.atendenteId : null,
        m: req.user ? req.user.matricula : null,
        id,
        det: JSON.stringify({ nomeInterno, cgcent, codcli, tags: tags.length }),
      }
    );
    await conn.commit();
    publish({ tipo: 'contato', contatoId: id });
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/contatos/:id/cobranca — títulos em aberto (WinThor PCPREST) do cliente
// vinculado ao contato. Só leitura; tolerante a falta de GRANT (ORA-00942).
router.get('/:id/cobranca', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    const row = await contatoNoEscopo(conn, id, req.perfil);
    if (!row) return res.status(404).json({ error: 'Contato não encontrado' });
    if (!row.CODCLI) return res.json({ codcli: null, resumo: null, titulos: [] });

    const resumo = await conn.execute(
      `SELECT COUNT(*) AS QTD, NVL(SUM(p.VALOR),0) AS SALDO,
              MIN(p.DTVENC) AS VENC_ANTIGO, (TRUNC(SYSDATE) - MIN(p.DTVENC)) AS DIAS_ATRASO_MAX
         FROM MCCANAL.PCPREST p
        WHERE p.CODCLI = :cod AND p.DTPAG IS NULL AND p.DTVENC < TRUNC(SYSDATE)`,
      { cod: row.CODCLI }
    );
    const titulos = await conn.execute(
      `SELECT * FROM (
         SELECT p.DUPLIC AS DUPLICATA, p.PREST AS PRESTACAO, p.CODFILIAL AS FILIAL,
                p.VALOR AS VALOR, p.DTVENC AS VENCIMENTO,
                (TRUNC(SYSDATE) - TRUNC(p.DTVENC)) AS DIAS_ATRASO
           FROM MCCANAL.PCPREST p
          WHERE p.CODCLI = :cod AND p.DTPAG IS NULL AND p.DTVENC < TRUNC(SYSDATE)
          ORDER BY p.DTVENC ASC
       ) WHERE ROWNUM <= 100`,
      { cod: row.CODCLI }
    );
    const res0 = resumo.rows[0] || {};
    res.json({
      codcli: row.CODCLI,
      resumo: {
        qtd: res0.QTD || 0,
        saldo: res0.SALDO || 0,
        vencAntigo: res0.VENC_ANTIGO || null,
        diasAtrasoMax: res0.DIAS_ATRASO_MAX || 0,
      },
      titulos: mapRows(titulos.rows),
    });
  } catch (err) {
    if (err.errorNum === 942) {
      return res.status(403).json({ error: 'Sem acesso à MCCANAL.PCPREST. Rode: GRANT SELECT ON MCCANAL.PCPREST TO MCLABS.' });
    }
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
