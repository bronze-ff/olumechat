// api/presenca.js — Presença do atendente (Fase 5B).
// PUT  /api/presenca { estado: 'online'|'pausa' } — o próprio atendente
// PUT  /api/presenca/:atendenteId { estado } — gestor força a presença de outro
// GET  /api/presenca — snapshot p/ o monitor (ADMIN/SUPERVISOR)
'use strict';

const express = require('express');
const presence = require('../realtime/presence');
const { exigirPapel, invalidar } = require('../auth/rbac');

const router = express.Router();

router.put('/', async (req, res, next) => {
  const estado = String((req.body && req.body.estado) || '');
  if (!['online', 'pausa'].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido (use 'online' ou 'pausa')" });
  }
  try {
    await presence.definirPausa(req.perfil.atendenteId, estado === 'pausa', req.user.tenantId);
    invalidar(req.user.matricula); // perfil.pausado muda
    res.json({ ok: true, estado });
  } catch (err) {
    next(err);
  }
});

// Gestor força a presença de um atendente (ex.: tirar da pausa pelo Monitor).
// Atua na MEMÓRIA + banco + avisa por SSE na hora — o atendente NÃO precisa dar
// F5. Só age sobre quem está conectado (presença é em memória; mexer no banco de
// quem está offline só valeria no próximo login, então retornamos 409 e orientamos).
// Visão enxuta para o atendimento: qualquer usuário autenticado pode ver os
// demais colegas disponíveis no mesmo tenant, sem receber ações de gestão.
router.get('/equipe', (req, res) => {
  const proprioId = Number(req.perfil && req.perfil.atendenteId);
  const equipe = presence.snapshot(req.user.tenantId)
    .filter((item) => item.estado === 'online' && item.atendenteId !== proprioId)
    .map(({ atendenteId, nome, deptoIds }) => ({ atendenteId, nome, deptoIds }));
  res.json(equipe);
});

router.put('/:atendenteId', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  const atendenteId = Number(req.params.atendenteId);
  const estado = String((req.body && req.body.estado) || '');
  if (!Number.isInteger(atendenteId) || atendenteId <= 0) {
    return res.status(400).json({ error: 'Atendente inválido' });
  }
  if (!['online', 'pausa'].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido (use 'online' ou 'pausa')" });
  }
  const info = presence.infoDe(atendenteId);
  // Mesma resposta para "nunca conectou" e "conectado em OUTRO tenant" — não
  // revela pra fora do tenant que o ID existe (isolamento também é sigilo de
  // existência, não só de dado).
  if (!info || info.tenantId !== req.user.tenantId) {
    return res.status(409).json({
      error: 'Atendente não está conectado — ele precisa entrar no sistema para a mudança valer.',
    });
  }
  try {
    await presence.definirPausa(atendenteId, estado === 'pausa', req.user.tenantId);
    if (info.matricula) invalidar(info.matricula); // o perfil.pausado dele muda
    res.json({ ok: true, atendenteId, estado });
  } catch (err) {
    next(err);
  }
});

router.get('/', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), (req, res) => {
  res.json(presence.snapshot(req.user.tenantId));
});

module.exports = router;
