// api/templates.js — Lista templates aprovados (para a tela de "Nova conversa").
const express = require('express');
const { listApprovedTemplates } = require('../graph/listTemplates');

const router = express.Router();

// Templates de amostra da Meta que não devem aparecer como opção de envio.
const OCULTOS = new Set(['hello_world']);

router.get('/', async (req, res) => {
  try {
    const todos = await listApprovedTemplates(req.tenantId);
    res.json(todos.filter((t) => !OCULTOS.has(t.name)));
  } catch (err) {
    res.status(502).json({ error: 'Falha ao listar templates: ' + err.message });
  }
});

module.exports = router;
