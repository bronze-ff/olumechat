// api/config.js — Configurações gerais do painel (chave/valor em `config`).
// Leitura: qualquer autenticado (o front usa p/ pré-preencher, ex. despedida).
// Escrita: ADMIN. Upsert por chave (INSERT ... ON CONFLICT) — chave nova não exige DDL.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const configCache = require('../utils/configCache');

const router = express.Router();

// Chaves conhecidas (whitelist — evita virar despejo de dados arbitrários).
const CHAVES = ['despedida_padrao', 'comando_encerrar', 'msg_encerrar_cliente',
  'fora_horario_ativo', 'horario_atendimento', 'fora_horario_msg', 'ia_sugestao_ativa'];

// GET /api/config — todas as configurações { chave: valor }.
router.get('/', async (req, res, next) => {
  try {
    const out = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(`SELECT chave, valor FROM config`);
      const acc = {};
      for (const row of r.rows) acc[row.CHAVE] = row.VALOR;
      return acc;
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// PUT /api/config — { chave: valor, ... } (ADMIN). Upsert das chaves conhecidas.
router.put('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const entradas = Object.entries(b).filter(([k]) => CHAVES.includes(k));
  if (!entradas.length) return res.status(400).json({ error: 'Nenhuma configuração válida no corpo' });

  try {
    await db.comTenant(req.tenantId, async (conn) => {
      for (const [chave, valor] of entradas) {
        await conn.execute(
          `INSERT INTO config (chave, valor) VALUES (:k, :v)
           ON CONFLICT (tenant_id, chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
          { k: chave, v: String(valor ?? '').slice(0, 2000) }
        );
      }
      await conn.execute(
        `INSERT INTO auditoria (matricula, acao, entidade, detalhe)
         VALUES (:m, 'config_update', 'config', :det)`,
        { m: req.user && req.user.matricula, det: JSON.stringify(Object.fromEntries(entradas)) }
      );
    });
    configCache.invalidar(req.tenantId); // webhook lê na hora
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
