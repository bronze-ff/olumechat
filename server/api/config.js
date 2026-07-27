// api/config.js — Configurações gerais do painel (chave/valor em MC_ZAP_CONFIG).
// Leitura: qualquer autenticado (o front usa p/ pré-preencher, ex. despedida).
// Escrita: ADMIN. Upsert por chave (MERGE) — chave nova não exige DDL.
'use strict';

const express = require('express');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const { codificar, decodificar } = require('../utils/texto');

const router = express.Router();

// Chaves conhecidas (whitelist — evita virar despejo de dados arbitrários).
const CHAVES = ['despedida_padrao', 'comando_encerrar', 'msg_encerrar_cliente',
  'fora_horario_ativo', 'horario_atendimento', 'fora_horario_msg'];

// GET /api/config — todas as configurações { chave: valor }.
router.get('/', async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const r = await conn.execute(`SELECT CHAVE, VALOR FROM MC_ZAP_CONFIG`);
    const out = {};
    for (const row of r.rows) out[row.CHAVE] = decodificar(row.VALOR);
    res.json(out);
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// PUT /api/config — { chave: valor, ... } (ADMIN). Upsert das chaves conhecidas.
router.put('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const entradas = Object.entries(b).filter(([k]) => CHAVES.includes(k));
  if (!entradas.length) return res.status(400).json({ error: 'Nenhuma configuração válida no corpo' });

  let conn;
  try {
    conn = await db.getConnection();
    for (const [chave, valor] of entradas) {
      await conn.execute(
        `MERGE INTO MC_ZAP_CONFIG c USING (SELECT :k AS CHAVE FROM DUAL) n
            ON (c.CHAVE = n.CHAVE)
          WHEN MATCHED THEN UPDATE SET c.VALOR = :v, c.ATUALIZADO_EM = SYSTIMESTAMP
          WHEN NOT MATCHED THEN INSERT (CHAVE, VALOR) VALUES (:k2, :v2)`,
        { k: chave, v: codificar(String(valor ?? '')).slice(0, 2000), k2: chave, v2: codificar(String(valor ?? '')).slice(0, 2000) }
      );
    }
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (MATRICULA, ACAO, ENTIDADE, DETALHE)
       VALUES (:m, 'config_update', 'config', :det)`,
      { m: req.user && req.user.matricula, det: JSON.stringify(Object.fromEntries(entradas)) }
    );
    await conn.commit();
    require('../utils/configCache').invalidar(); // webhook lê na hora
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
