// api/contatos.js — Ficha do contato: identificação interna + vínculo com o
// sistema do tenant (seam clienteLookup).
//
// O contato chega com o NOME_PERFIL do WhatsApp (ex.: "somente wattzap"). Aqui a
// gente grava NO CONTATO (vale para todas as conversas daquele telefone): nome
// interno/apelido, documento (CPF/CNPJ), vínculo com o código externo do tenant,
// observações e tags. CODIGO_EXTERNO/DOCUMENTO eram CODCLI/CGCENT do ERP WinThor
// do fork original — generalizados (ver docs/PORTE.md "Resíduo conhecido" e a
// migração 002).
'use strict';

const express = require('express');
const db = require('../db/pool');
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
    `SELECT ct.id, ct.telefone, ct.nome_perfil, ct.nome_interno, ct.codigo_externo, ct.documento,
            ct.observacoes, ct.tags_contato, ct.atualizado_em,
            a.nome AS atualizado_por_nome
       FROM contato ct
       LEFT JOIN atendente a ON a.tenant_id = ct.tenant_id AND a.id = ct.atualizado_por
      WHERE ct.id = :id`,
    { id }
  );
  if (!r.rows.length) return null;
  if (!perfil || perfil.papel === 'ADMIN' || perfil.papel === 'AUDITOR') return r.rows[0];

  // Existe alguma conversa deste contato no escopo do atendente?
  const binds = { id };
  const partes = ['c.departamento_id IS NULL'];
  if (perfil.atendenteId) { partes.push('c.atendente_id = :atd'); binds.atd = perfil.atendenteId; }
  (perfil.deptoIds || []).forEach((d, i) => { binds['d' + i] = d; });
  if ((perfil.deptoIds || []).length) {
    partes.push(`c.departamento_id IN (${perfil.deptoIds.map((_, i) => ':d' + i).join(',')})`);
  }
  let numFiltro = '';
  if ((perfil.numeroIds || []).length) {
    perfil.numeroIds.forEach((n, i) => { binds['n' + i] = n; });
    const ns = perfil.numeroIds.map((_, i) => ':n' + i).join(',');
    numFiltro = ` AND (c.numero_id IS NULL OR c.numero_id IN (${ns})${perfil.atendenteId ? ' OR c.atendente_id = :atd' : ''})`;
  }
  const ok = await conn.execute(
    `SELECT 1 FROM conversa c
      WHERE c.contato_id = :id AND (${partes.join(' OR ')})${numFiltro}
      FETCH FIRST 1 ROWS ONLY`,
    binds
  );
  return ok.rows.length ? r.rows[0] : null;
}

function montarFicha(row) {
  return {
    id: row.ID,
    telefone: row.TELEFONE,
    nomePerfil: row.NOME_PERFIL,
    nomeInterno: row.NOME_INTERNO,
    codigoExterno: row.CODIGO_EXTERNO || null,
    documento: row.DOCUMENTO || null,
    observacoes: row.OBSERVACOES,
    // jsonb já chega decodificado pelo driver `pg` (ver db/pool.js) — só faz
    // parse se, por algum motivo, ainda vier como string (defensivo).
    tags: typeof row.TAGS_CONTATO === 'string' ? JSON.parse(row.TAGS_CONTATO) : (row.TAGS_CONTATO || []),
    atualizadoPor: row.ATUALIZADO_POR_NOME || null,
    atualizadoEm: row.ATUALIZADO_EM || null,
  };
}

// GET /api/contatos/:id — ficha do contato. Se ainda não tem CODIGO_EXTERNO,
// tenta uma SUGESTÃO de cliente pelo telefone (pra identificar contatos antigos
// sem mexer).
router.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const ficha = await db.comTenant(req.tenantId, async (conn) => {
      const row = await contatoNoEscopo(conn, id, req.perfil);
      if (!row) return null;
      const f = montarFicha(row);
      if (f.codigoExterno) {
        // Dados do cliente no sistema do tenant (vendedor/supervisor/telefones) — best-effort.
        f.dadosExternos = await dadosClienteWinthor(conn, f.codigoExterno);
      } else {
        const sug = await acharClientePorTelefone(conn, row.TELEFONE);
        if (sug) f.sugestao = { codigoExterno: sug.codigo, nome: sug.nome, documento: sug.documento };
      }
      return f;
    });
    if (!ficha) return res.status(404).json({ error: 'Contato não encontrado' });
    res.json(ficha);
  } catch (err) {
    next(err);
  }
});

// PUT /api/contatos/:id — salva a ficha { nomeInterno?, observacoes?, documento?, codigoExterno?, tags? }.
router.put('/:id', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};
  const nomeInterno = b.nomeInterno != null ? String(b.nomeInterno).trim().slice(0, 200) : null;
  const observacoes = b.observacoes != null ? String(b.observacoes).trim().slice(0, 2000) : null;
  const documento = b.documento != null ? String(b.documento).replace(/\D/g, '').slice(0, 20) || null : null;
  const codigoExterno = b.codigoExterno != null && b.codigoExterno !== '' ? Number(b.codigoExterno) : null;
  if (codigoExterno != null && !Number.isInteger(codigoExterno)) return res.status(400).json({ error: 'codigoExterno inválido' });
  const tags = Array.isArray(b.tags) ? b.tags.map(Number).filter(Number.isInteger) : [];

  try {
    const encontrado = await db.comTenant(req.tenantId, async (conn) => {
      const { tipos } = db;
      if (!(await contatoNoEscopo(conn, id, req.perfil))) return false;
      await conn.execute(
        // Atribuição direta (não COALESCE): o formulário SEMPRE manda o valor
        // atual, então limpar um campo (ex.: "desvincular" o CODIGO_EXTERNO)
        // precisa persistir como NULL. Binds numéricos/string vão com tipo
        // explícito para o NULL não virar tipo errado.
        `UPDATE contato
            SET nome_interno   = :ni,
                observacoes    = :obs,
                documento      = :doc,
                codigo_externo = :cod,
                tags_contato   = :tags,
                atualizado_por = :atd,
                atualizado_em  = now()
          WHERE id = :id`,
        {
          ni: nomeInterno,
          obs: observacoes,
          doc: { type: tipos.STRING, val: documento },
          cod: { type: tipos.NUMBER, val: codigoExterno },
          tags: tags.length ? JSON.stringify(tags) : null,
          atd: req.perfil ? req.perfil.atendenteId : null,
          id,
        }
      );
      // Trilha "editado por/em".
      await conn.execute(
        `INSERT INTO auditoria (atendente_id, matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:atd, :m, 'edicao_contato', 'contato', :id, :det)`,
        {
          atd: req.perfil ? req.perfil.atendenteId : null,
          m: req.user ? req.user.matricula : null,
          id,
          det: JSON.stringify({ nomeInterno, documento, codigoExterno, tags: tags.length }),
        }
      );
      return true;
    });
    if (!encontrado) return res.status(404).json({ error: 'Contato não encontrado' });
    publish({ tipo: 'contato', contatoId: id, tenantId: req.tenantId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/contatos/:id/cobranca — mini-painel de cobrança do cliente vinculado
// ao contato. O fork original lia MCCANAL.PCPREST (WinThor, ERP on-prem) — essa
// tabela não existe no Postgres/Neon (não é dado migrado, é de outro sistema).
// Sem um provedor de cobrança por tenant (fora deste ticket — não é o seam de
// clienteLookup.js, que só resolve IDENTIFICAÇÃO), o endpoint degrada para
// "sem dados", igual ao clienteLookup faz sem provedor registrado.
router.get('/:id/cobranca', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const row = await db.comTenant(req.tenantId, (conn) => contatoNoEscopo(conn, id, req.perfil));
    if (!row) return res.status(404).json({ error: 'Contato não encontrado' });
    res.json({ codigoExterno: row.CODIGO_EXTERNO || null, resumo: null, titulos: [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
