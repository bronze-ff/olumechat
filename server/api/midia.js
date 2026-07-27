// api/midia.js — Serve o binário de uma mídia recebida (auth obrigatória).
// O webhook já baixou o arquivo para o servidor de arquivos (MEDIA_DIR) e
// gravou o caminho em mensagem.midia_caminho. Aqui apenas transmitimos
// o arquivo, validando que o caminho está DENTRO do MEDIA_DIR (anti path-traversal).
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/pool');
const { cfg } = require('../graph/client');

const router = express.Router();

// GET /api/midia/:id — devolve o arquivo da mensagem :id (inline).
router.get('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

  try {
    const row = await db.comTenant(req.tenantId, async (conn) => {
      // Escopo: traz o departamento/número/atendente da conversa da mensagem para
      // validar que o usuário pode ver esta mídia (fecha IDOR — antes qualquer
      // atendente baixava anexos de qualquer conversa iterando o ID).
      const r = await conn.execute(
        `SELECT m.midia_caminho, m.mime_type, m.nome_arquivo,
                c.departamento_id, c.numero_id, c.atendente_id
           FROM mensagem m
           LEFT JOIN conversa c ON c.tenant_id = m.tenant_id AND c.id = m.conversa_id
          WHERE m.id = :id`,
        { id }
      );
      return r.rows.length ? r.rows[0] : null;
    });
    if (!row) return res.status(404).json({ error: 'Mensagem não encontrada' });

    const perfil = req.perfil;
    if (perfil && perfil.papel !== 'ADMIN' && perfil.papel !== 'AUDITOR') {
      const ehMinha = perfil.atendenteId && row.ATENDENTE_ID === perfil.atendenteId;
      const deptoOk = row.DEPARTAMENTO_ID == null || ehMinha || (perfil.deptoIds || []).includes(row.DEPARTAMENTO_ID);
      const meusNum = perfil.numeroIds || [];
      const numOk = !meusNum.length || row.NUMERO_ID == null || ehMinha || meusNum.includes(row.NUMERO_ID);
      if (!deptoOk || !numOk) return res.status(404).json({ error: 'Mensagem não encontrada' });
    }
    const caminho = row.MIDIA_CAMINHO;
    if (!caminho) return res.status(404).json({ error: 'Mensagem sem mídia salva' });

    // Segurança: o arquivo precisa estar dentro do MEDIA_DIR.
    const baseDir = path.resolve(cfg.mediaDir);
    const resolved = path.resolve(caminho);
    if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
      return res.status(403).json({ error: 'Caminho de mídia inválido' });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'Arquivo não encontrado no servidor' });
    }

    if (row.MIME_TYPE) res.type(row.MIME_TYPE);
    const nome = (row.NOME_ARQUIVO || path.basename(resolved)).replace(/"/g, '');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(nome)}"`);

    const stream = fs.createReadStream(resolved);
    stream.on('error', (err) => {
      console.error('[midia] erro ao ler arquivo:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Erro ao ler o arquivo' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
