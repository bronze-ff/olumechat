'use strict';

const express = require('express');
const db = require('../db/pool');
const { storage } = require('../storage');

const router = express.Router();

// A primeira chamada autentica o operador e emite um link curto. A segunda
// valida a assinatura (incluindo tenant e expiração) antes de ler o objeto.
router.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const token = req.query.storage_token;
    if (token && typeof storage.verificar === 'function') {
      // A chave ainda não é conhecida antes da consulta, mas o prefixo assinado
      // permite negar imediatamente um link de outro tenant.
      const partes = String(token).split('.')[0];
      let payload;
      try { payload = JSON.parse(Buffer.from(partes, 'base64url').toString()); } catch {
        return res.status(403).json({ error: 'URL de mídia inválida ou expirada' });
      }
      if (String(payload.key || '').split('/')[0] !== String(req.tenantId) || !storage.verificar(token, payload.key)) {
        return res.status(403).json({ error: 'URL de mídia inválida ou expirada' });
      }
    }

    const row = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `SELECT m.midia_caminho, m.mime_type, m.nome_arquivo,
                c.departamento_id, c.numero_id, c.atendente_id
           FROM mensagem m
           LEFT JOIN conversa c ON c.tenant_id = m.tenant_id AND c.id = m.conversa_id
          WHERE m.id = :id`, { id });
      return r.rows.length ? r.rows[0] : null;
    });
    if (!row) return res.status(404).json({ error: 'Mensagem não encontrada' });

    const perfil = req.perfil;
    if (perfil && perfil.papel !== 'ADMIN' && perfil.papel !== 'AUDITOR') {
      const ehMinha = perfil.atendenteId && row.ATENDENTE_ID === perfil.atendenteId;
      const deptoOk = row.DEPARTAMENTO_ID == null || ehMinha || (perfil.deptoIds || []).includes(row.DEPARTAMENTO_ID);
      const numOk = !(perfil.numeroIds || []).length || row.NUMERO_ID == null || ehMinha || perfil.numeroIds.includes(row.NUMERO_ID);
      if (!deptoOk || !numOk) return res.status(404).json({ error: 'Mensagem não encontrada' });
    }
    const chave = row.MIDIA_CAMINHO;
    if (!chave) return res.status(404).json({ error: 'Mensagem sem mídia salva' });
    if (!token) {
      const url = await storage.urlAssinada(chave, { expiresIn: 300, baseUrl: `${req.baseUrl}/${id}` });
      return res.redirect(302, url);
    }
    if (typeof storage.verificar === 'function' && !storage.verificar(token, chave)) {
      return res.status(403).json({ error: 'URL de mídia inválida ou expirada' });
    }
    const data = await storage.ler(chave);
    if (row.MIME_TYPE) res.type(row.MIME_TYPE);
    const nome = String(row.NOME_ARQUIVO || chave.split('/').pop()).replace(/"/g, '');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(nome)}"`);
    return res.send(data);
  } catch (err) { return next(err); }
});

module.exports = router;
