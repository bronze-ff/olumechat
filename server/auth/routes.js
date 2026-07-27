// auth/routes.js — Login PRÓPRIO do Falatta (FIL-67): tabela `usuario` por
// tenant, senha em argon2id. Substitui a autenticação contra a tabela de
// senhas do ERP do cliente original (texto plano, comparada com UPPER()) —
// era o último ponto do sistema que ainda dependia do fork.
//
// ── COMO O TENANT É RESOLVIDO NO LOGIN ──────────────────────────────────────
// A credencial é um TRIO: empresa (slug do tenant) + e-mail + senha. O slug é
// necessário porque `usuario` é único por (tenant_id, email) — o mesmo e-mail
// pode existir em dois clientes do SaaS, e sem o slug não dá para saber qual
// linha conferir.
//
// Isso NÃO é "aceitar tenant_id do cliente". O slug apenas escolhe CONTRA QUAL
// linha a senha será conferida; sozinho ele não autentica nem autoriza nada.
// Depois do login, o tenant vive só dentro do JWT assinado, e nenhuma rota
// aceita tenant por header/query/body (ver auth/middleware.js).
//
// ── 401 UNIFORME ────────────────────────────────────────────────────────────
// Empresa inexistente, e-mail inexistente, senha errada, usuário inativo,
// usuário que ainda não definiu senha e usuário de OUTRO tenant devolvem
// exatamente a mesma resposta 401, com o mesmo texto. Todos os caminhos também
// gastam um argon2 (real ou descartável), para o TEMPO não denunciar qual dos
// casos ocorreu. Uma resposta que diferencie "e-mail não existe" de "senha
// errada" é um verificador de contas de graça para quem tem uma lista de
// e-mails vazados.
//
// ── SENHA NUNCA APARECE ─────────────────────────────────────────────────────
// Nem em log (o morgan registra só método/URL), nem em resposta — inclusive
// nas de erro de validação: `validationResult().array()` inclui o VALOR do
// campo por padrão, então aqui só devolvemos `{ campo, msg }`.
'use strict';

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');

const db = require('../db/pool');
const blacklist = require('../utils/tokenBlacklist');
const auth = require('./middleware');
const rbac = require('./rbac');
const senhas = require('./senha');
const tokenSenha = require('./tokenSenha');
const { SECRET, EXPIRES_IN } = require('./secret');

const router = express.Router();

/** Resposta única de credencial recusada — ver "401 UNIFORME" no cabeçalho. */
const MSG_401 = 'Usuário ou senha inválidos.';
/** Resposta única de link de definição de senha recusado. */
const MSG_LINK = 'Link inválido ou expirado. Peça um novo ao administrador.';

// Atrás de um proxy o X-Forwarded-For pode chegar com PORTA ("172.16.0.1:61727")
// e a lib rejeita (ERR_ERL_INVALID_IP_ADDRESS, spam no stderr). Tira a porta de
// IPv4 e desliga a validação de trust proxy (o app já fixa `trust proxy` em 1).
function chavePorIp(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return m ? m[1] : ip;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chavePorIp,
  validate: { trustProxy: false },
  // JSON, não o texto padrão da lib: o front lê `error` de todas as respostas
  // de /api e mostraria "credenciais inválidas" para um 429.
  message: { error: 'Muitas tentativas. Espere alguns minutos e tente de novo.' },
});

// Definição de senha: o token tem 256 bits (não dá para adivinhar), mas o
// endpoint faz argon2 — sem teto ele vira um amplificador de CPU.
const senhaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chavePorIp,
  validate: { trustProxy: false },
  message: { error: 'Muitas tentativas. Espere alguns minutos e tente de novo.' },
});

/** 400 sem ecoar valores (a senha é um dos campos validados). */
function checarValidacao(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    error: 'Dados inválidos.',
    errors: errors.array().map((e) => ({ campo: e.path, msg: e.msg })),
  });
  return true;
}

/**
 * slug do tenant → id, ou null. Lê SÓ a tabela `tenant` (id/slug/status) —
 * nenhum dado de tenant. É a única consulta legítima fora de comTenant(): a
 * policy `tenant_operador` da migração 001 autoriza exatamente esta leitura
 * sem contexto, e sem ela não haveria como descobrir o contexto a usar.
 */
async function resolverTenant(slug) {
  if (typeof slug !== 'string' || !slug) return null;
  const conn = await db.getConnection();
  try {
    const r = await conn.execute(
      `SELECT id FROM tenant WHERE slug = :slug AND status = 'ativo'`,
      { slug }
    );
    if (!r.rows.length) return null;
    const id = Number(r.rows[0].ID);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } finally {
    await conn.close().catch(() => {});
  }
}

const normalizarSlug = (v) => String(v || '').trim().toLowerCase();
const normalizarEmail = (v) => String(v || '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post(
  '/login',
  loginLimiter,
  body('empresa').isString().isLength({ min: 1, max: 60 }).trim(),
  body('email').isString().isLength({ min: 3, max: 160 }).trim(),
  body('senha').isString().isLength({ min: 1, max: senhas.MAX }),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    const { senha } = req.body;
    const slug = normalizarSlug(req.body.empresa);
    const email = normalizarEmail(req.body.email);

    try {
      const tenantId = await resolverTenant(slug);
      if (!tenantId) {
        await senhas.conferirFalso(senha); // equaliza o tempo — ver cabeçalho
        return res.status(401).json({ error: MSG_401 });
      }

      // O filtro `tenant_id = :tenantId` é redundante com a RLS de propósito:
      // é a defesa que continua valendo se alguém rodar esta query fora de
      // comTenant() um dia (defesa em profundidade, auditável).
      const u = await db.comTenant(tenantId, async (conn) => {
        const r = await conn.execute(
          `SELECT id, nome, email, senha_hash, ativo
             FROM usuario
            WHERE tenant_id = :tenantId AND email = :email`,
          { tenantId, email }
        );
        return r.rows[0] || null;
      });

      // Usuário de outro tenant cai aqui como "não existe": a query rodou no
      // contexto do tenant do slug, então a linha do outro nunca é visível.
      if (!u || u.ATIVO !== 'S' || !u.SENHA_HASH) {
        await senhas.conferirFalso(senha);
        return res.status(401).json({ error: MSG_401 });
      }
      if (!(await senhas.conferir(u.SENHA_HASH, senha))) {
        return res.status(401).json({ error: MSG_401 });
      }

      const usuarioId = Number(u.ID);
      const payload = {
        jti: crypto.randomUUID(),
        tenantId,
        usuarioId,
        // `matricula` é a chave operacional do RBAC no resto do sistema
        // (req.user.matricula em api/, fila/, realtime/). O login próprio usa
        // o id do usuário como matrícula — ver a migração 004.
        matricula: usuarioId,
        nome: u.NOME,
        email: u.EMAIL,
      };
      const token = jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });

      // Perfil RBAC (papel + departamentos) — cria o atendente no 1º login.
      // Falha aqui não bloqueia o login (front cai no padrão ATENDENTE).
      let papel = 'ATENDENTE', deptoIds = [], pausado = false, podeAtivo = false;
      try {
        const perfil = await rbac.carregarPerfil(tenantId, usuarioId, u.NOME);
        papel = perfil.papel;
        deptoIds = perfil.deptoIds;
        pausado = !!perfil.pausado;
        podeAtivo = !!perfil.podeAtivo;
      } catch (e) {
        console.error('[auth] falha ao carregar perfil RBAC:', e.message);
      }

      res.json({
        token, usuarioId, matricula: usuarioId, nome: u.NOME, email: u.EMAIL,
        empresa: slug, papel, deptoIds, pausado, podeAtivo,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/auth/definir-senha?empresa=&token=
// Diz se o link ainda vale, ANTES de o usuário digitar a senha. Não consome.
// ---------------------------------------------------------------------------
router.get(
  '/definir-senha',
  senhaLimiter,
  query('empresa').isString().isLength({ min: 1, max: 60 }).trim(),
  query('token').isString().isLength({ min: 20, max: 200 }).trim(),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    try {
      const tenantId = await resolverTenant(normalizarSlug(req.query.empresa));
      if (!tenantId) return res.status(400).json({ error: MSG_LINK });
      const r = await tokenSenha.verificarToken(tenantId, req.query.token);
      if (!r.valido) return res.status(400).json({ error: MSG_LINK });
      res.json({ valido: true, nome: r.nome, email: r.email, minimo: senhas.MIN });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/auth/definir-senha  { empresa, token, senha }
// Primeiro acesso: consome o token (uso único) e grava o hash da senha.
// ---------------------------------------------------------------------------
router.post(
  '/definir-senha',
  senhaLimiter,
  body('empresa').isString().isLength({ min: 1, max: 60 }).trim(),
  body('token').isString().isLength({ min: 20, max: 200 }).trim(),
  body('senha').isString().isLength({ min: 1, max: senhas.MAX }),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    try {
      // Política de senha ANTES de tocar o banco: o usuário merece "curta
      // demais" em vez do genérico de link inválido.
      const problema = senhas.validarForca(req.body.senha);
      if (problema) return res.status(400).json({ error: problema });

      const tenantId = await resolverTenant(normalizarSlug(req.body.empresa));
      if (!tenantId) return res.status(400).json({ error: MSG_LINK });

      const r = await tokenSenha.definirSenha(tenantId, req.body.token, req.body.senha);
      // Token inexistente, expirado, já usado ou de usuário desativado saem
      // todos com a MESMA mensagem (mesmo motivo do 401 uniforme do login).
      if (!r.ok) return res.status(400).json({ error: MSG_LINK });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/auth/logout — jti na blacklist (o JWT em si continua assinado).
// ---------------------------------------------------------------------------
router.post('/logout', auth, (req, res) => {
  if (req.user && req.user.jti) blacklist.add(req.user.jti);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/auth/perfil — papel/departamentos atuais (usado no reload da
// página, já que o JWT não carrega o papel — ele pode mudar sem relogin).
// ---------------------------------------------------------------------------
router.get('/perfil', auth, async (req, res, next) => {
  try {
    // Sessão de suporte do operador (FIL-70) não tem matrícula — não é gente
    // do cliente. Mandá-la para carregarPerfil faria o RBAC criar um
    // `atendente` lazy com matrícula nula (500 no reload da página). Mesmo
    // perfil fixo que auth/rbac.js::anexarPerfil já dá às rotas REST.
    if (req.user.suporte === true) {
      const s = rbac.PERFIL_SUPORTE;
      return res.json({
        papel: s.papel, deptoIds: s.deptoIds, atendenteId: s.atendenteId,
        pausado: s.pausado, podeAtivo: s.podeAtivo, suporte: true,
      });
    }
    const p = await rbac.carregarPerfil(req.user.tenantId, req.user.matricula, req.user.nome);
    res.json({
      papel: p.papel, deptoIds: p.deptoIds, atendenteId: p.atendenteId,
      pausado: !!p.pausado, podeAtivo: !!p.podeAtivo,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
