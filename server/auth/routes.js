// auth/routes.js — Login contra MCCANAL.MC_SENHAS + logout (jti-blacklist).
// Requer GRANT SELECT ON MCCANAL.MC_SENHAS TO MCLABS (ver 00_create_schema.sql).
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const db = require('../db/pool');
const blacklist = require('../utils/tokenBlacklist');
const auth = require('./middleware');
const rbac = require('./rbac');
const { SECRET, EXPIRES_IN } = require('./secret');

const router = express.Router();

const DIRETORES = (process.env.DIRETORES_MATRICULAS || '').split(',').filter(Boolean);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Atrás do IIS/ARR o X-Forwarded-For chega com PORTA ("172.16.0.1:61727") e a
  // lib rejeita (ERR_ERL_INVALID_IP_ADDRESS, spam no stderr.log). Tira a porta
  // de IPv4 e desliga a validação de trust proxy (rede interna, atrás do IIS).
  keyGenerator: (req) => {
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    return m ? m[1] : ip;
  },
  validate: { trustProxy: false },
});

router.post(
  '/login',
  loginLimiter,
  body('matricula').isString().isLength({ min: 1, max: 10 }).trim(),
  body('senha').isString().isLength({ min: 1, max: 100 }),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    next();
  },
  async (req, res, next) => {
    const { matricula, senha } = req.body;
    let conn;
    try {
      conn = await db.getConnection();
      const result = await conn.execute(
        `SELECT MATRICULA, NOME, CODUSUR
           FROM MCCANAL.MC_SENHAS
          WHERE MATRICULA    = :matricula
            AND UPPER(SENHA) = UPPER(:senha)`,
        { matricula, senha }
      );
      if (!result.rows || result.rows.length === 0) {
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }
      const u = result.rows[0];
      const payload = {
        jti: crypto.randomUUID(),
        matricula: u.MATRICULA,
        codusur: u.CODUSUR,
        nome: u.NOME,
        isDiretor: DIRETORES.includes(String(u.MATRICULA)),
      };
      const token = jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });

      // Perfil RBAC (papel + departamentos) — cria o atendente no 1º login.
      // Falha aqui não bloqueia o login (front cai no padrão ATENDENTE).
      let papel = 'ATENDENTE', deptoIds = [], pausado = false, podeAtivo = false;
      try {
        const perfil = await rbac.carregarPerfil(u.MATRICULA, u.NOME);
        papel = perfil.papel;
        deptoIds = perfil.deptoIds;
        pausado = !!perfil.pausado;
        podeAtivo = !!perfil.podeAtivo;
      } catch (e) {
        console.error('[auth] falha ao carregar perfil RBAC:', e.message);
      }

      res.json({ token, matricula: u.MATRICULA, nome: u.NOME, codusur: u.CODUSUR, papel, deptoIds, pausado, podeAtivo });
    } catch (err) {
      next(err);
    } finally {
      if (conn) await conn.close().catch(() => {});
    }
  }
);

router.post('/logout', auth, (req, res) => {
  if (req.user && req.user.jti) blacklist.add(req.user.jti);
  res.json({ ok: true });
});

// GET /api/auth/perfil — papel/departamentos atuais (usado no reload da página,
// já que o JWT não carrega o papel — ele pode mudar sem relogin).
router.get('/perfil', auth, async (req, res, next) => {
  try {
    const p = await rbac.carregarPerfil(req.user.matricula, req.user.nome);
    res.json({ papel: p.papel, deptoIds: p.deptoIds, atendenteId: p.atendenteId, pausado: !!p.pausado, podeAtivo: !!p.podeAtivo });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
