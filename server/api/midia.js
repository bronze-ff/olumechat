// api/midia.js — Serve o binário de uma mídia recebida (auth obrigatória).
// O webhook já baixou o arquivo para o servidor de arquivos (MEDIA_DIR) e
// gravou o caminho em MC_ZAP_MENSAGEM.MIDIA_CAMINHO. Aqui apenas transmitimos
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

  let conn;
  try {
    conn = await db.getConnection();
    // Escopo: traz o departamento/número/atendente da conversa da mensagem para
    // validar que o usuário pode ver esta mídia (fecha IDOR — antes qualquer
    // atendente baixava anexos de qualquer conversa iterando o ID).
    const r = await conn.execute(
      `SELECT m.MIDIA_CAMINHO, m.MIME_TYPE, m.NOME_ARQUIVO,
              c.DEPARTAMENTO_ID, c.NUMERO_ID, c.ATENDENTE_ID
         FROM MC_ZAP_MENSAGEM m
         LEFT JOIN MC_ZAP_CONVERSA c ON c.ID = m.CONVERSA_ID
        WHERE m.ID = :id`,
      { id }
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Mensagem não encontrada' });

    const row = r.rows[0];
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
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
