// operador/routes.js — API do painel do operador (FIL-70): /api/operador/*.
//
// Prefixo próprio, middleware próprio (operador/middleware.js), sessão e JWT
// próprios (operador/segredo.js). NADA aqui compartilha a cadeia de
// middlewares do painel do cliente — é o requisito central do ticket.
//
// ── O CONVITE VOLTA NA RESPOSTA (DECISÃO PROVISÓRIA) ────────────────────────
// Ainda não há envio de e-mail no sistema. Então o provisionamento DEVOLVE o
// link de definição de senha na resposta da API, e o operador o repassa ao
// cliente pelo canal que já usa. Consequências assumidas:
//   • o link é um segredo de uso único e expira (auth/tokenSenha.js);
//   • ele NUNCA vai para log nem para a auditoria — só para a resposta da
//     requisição que o criou. Quem fechar a tela sem copiar precisa de um
//     convite novo.
// Quando existir envio de e-mail, o link deixa de sair na resposta.
'use strict';

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');

const { mapRows, mapRow } = require('../utils/linhas');
const blacklist = require('../utils/tokenBlacklist');
const senhas = require('../auth/senha');
const { SECRET: SECRET_TENANT } = require('../auth/secret');
const { SECRET, EXPIRES_IN } = require('./segredo');
const { comOperador } = require('./db');
const autenticarOperador = require('./middleware');
const contas = require('./contas');
const auditoria = require('./auditoria');
const tenants = require('./tenants');

const router = express.Router();

/** Resposta única de credencial recusada (mesmo racional do login de tenant). */
const MSG_401 = 'Usuário ou senha inválidos.';

/** Minutos de validade da sessão de SUPORTE dentro de um tenant. */
const SUPORTE_TTL_MIN = Number(process.env.OPERADOR_SUPORTE_TTL_MIN) || 30;

/** Base pública do painel, usada para montar o link do convite. */
function baseDoApp() {
  return String(process.env.APP_URL || 'http://localhost:3001').replace(/\/+$/, '');
}
function linkDeConvite(slug, token) {
  return `${baseDoApp()}/definir-senha?empresa=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`;
}

// Atrás de um proxy o X-Forwarded-For pode chegar com PORTA — ver auth/routes.js.
function chavePorIp(req) {
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
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

/** Erro de negócio (ErroOperador) vira status próprio; o resto sobe. */
function tratar(err, res, next) {
  if (err && err.deOperador) return res.status(err.status).json({ error: err.message });
  return next(err);
}

/** id de rota (:id) validado como inteiro positivo. */
function idDaRota(req, res) {
  const id = tenants.idValido(req.params.id);
  if (!id) { res.status(400).json({ error: 'ID inválido' }); return null; }
  return id;
}

// ---------------------------------------------------------------------------
// POST /api/operador/login  { email, senha }
// Sessão SEPARADA da do tenant: segredo próprio e claim `escopo: 'operador'`,
// sem `tenantId` (é justamente o que faz este token não valer nas rotas de
// tenant — auth/middleware.js rejeita token sem tenant).
// ---------------------------------------------------------------------------
router.post(
  '/login',
  loginLimiter,
  body('email').isString().isLength({ min: 3, max: 160 }).trim(),
  body('senha').isString().isLength({ min: 1, max: senhas.MAX }),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    const email = contas.normalizarEmail(req.body.email);
    const { senha } = req.body;
    const ip = auditoria.ipDaRequisicao(req);

    try {
      const o = await contas.buscarPorEmail(email);
      // E-mail inexistente, conta desativada e senha errada saem iguais — e
      // todos gastam um argon2 (real ou descartável), para o TEMPO não
      // denunciar qual foi. Mesmo racional do login de tenant.
      const ok = o && o.ATIVO === 'S' && await senhas.conferir(o.SENHA_HASH, senha);
      if (!ok) {
        if (!o || o.ATIVO !== 'S') await senhas.conferirFalso(senha);
        await comOperador((conn) => auditoria.registrar(conn, {
          operador: o ? { id: Number(o.ID), email: o.EMAIL } : { id: null, email },
          acao: 'login_recusado', entidade: 'operador', entidadeId: o ? Number(o.ID) : null,
          detalhe: { email }, ip,
        })).catch((e) => console.error('[operador] falha ao auditar login recusado:', e.message));
        return res.status(401).json({ error: MSG_401 });
      }

      const operador = { id: Number(o.ID), email: o.EMAIL, nome: o.NOME };
      const jti = crypto.randomUUID();
      await comOperador(async (conn) => {
        await contas.marcarAcesso(conn, operador.id);
        await auditoria.registrar(conn, {
          operador, acao: 'login', entidade: 'operador', entidadeId: operador.id, ip,
        });
      });

      const token = jwt.sign(
        { jti, escopo: 'operador', operadorId: operador.id, nome: operador.nome, email: operador.email },
        SECRET, { expiresIn: EXPIRES_IN }
      );
      res.json({ token, id: operador.id, nome: operador.nome, email: operador.email });
    } catch (err) {
      next(err);
    }
  }
);

// A partir daqui, TUDO exige sessão de operador.
router.use(autenticarOperador);

// ---------------------------------------------------------------------------
// POST /api/operador/logout — jti na blacklist.
// ---------------------------------------------------------------------------
router.post('/logout', async (req, res, next) => {
  try {
    if (req.operador.jti) blacklist.add(req.operador.jti);
    await comOperador((conn) => auditoria.registrar(conn, {
      operador: req.operador, acao: 'logout', entidade: 'operador',
      entidadeId: req.operador.id, ip: auditoria.ipDaRequisicao(req),
    }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/operador/eu — quem está logado (o front usa no reload da página).
router.get('/eu', (req, res) => {
  res.json({ id: req.operador.id, nome: req.operador.nome, email: req.operador.email });
});

// ---------------------------------------------------------------------------
// GET /api/operador/tenants — listagem com uso por cliente.
// ---------------------------------------------------------------------------
router.get('/tenants', async (req, res, next) => {
  try {
    res.json(mapRows(await tenants.listarComUso()));
  } catch (err) {
    tratar(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// POST /api/operador/tenants — PROVISIONAR.
// { nome, slug, admin: { nome?, email } } → tenant + usuário ADMIN + convite,
// numa transação só. Devolve o link do convite (ver cabeçalho do arquivo).
// ---------------------------------------------------------------------------
router.post(
  '/tenants',
  body('nome').isString().isLength({ min: 1, max: 160 }).trim(),
  body('slug').isString().isLength({ min: 2, max: 60 }).trim(),
  body('admin.email').isString().isLength({ min: 3, max: 160 }).trim(),
  body('admin.nome').optional({ nullable: true }).isString().isLength({ max: 120 }).trim(),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    try {
      const r = await tenants.provisionar({
        operador: req.operador,
        nome: req.body.nome,
        slug: req.body.slug,
        admin: req.body.admin || {},
        ip: auditoria.ipDaRequisicao(req),
      });
      res.status(201).json({
        tenant: mapRow(r.tenant),
        usuario: mapRow(r.usuario),
        convite: {
          // O token em claro vive só nesta resposta.
          link: linkDeConvite(r.tenant.SLUG, r.convite.token),
          expiraEm: r.convite.expiraEm.toISOString(),
        },
        aviso: 'Copie o link do convite agora: ele não é exibido de novo e não é enviado por e-mail ainda.',
      });
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/operador/tenants/:id — renomear (o slug é imutável).
// ---------------------------------------------------------------------------
router.patch(
  '/tenants/:id',
  body('nome').isString().isLength({ min: 1, max: 160 }).trim(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    if (checarValidacao(req, res)) return;
    try {
      res.json(await tenants.renomear({
        operador: req.operador, tenantId: id, nome: req.body.nome,
        ip: auditoria.ipDaRequisicao(req),
      }));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/operador/tenants/:id/suspender  { motivo? }
// Bloqueia o login dos usuários do cliente e pausa os disparos de campanha
// (ver operador/tenants.js::alterarStatus).
// ---------------------------------------------------------------------------
router.post(
  '/tenants/:id/suspender',
  body('motivo').optional({ nullable: true }).isString().isLength({ max: 200 }).trim(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    if (checarValidacao(req, res)) return;
    try {
      res.json(await tenants.alterarStatus({
        operador: req.operador, tenantId: id, status: 'suspenso',
        motivo: req.body.motivo, ip: auditoria.ipDaRequisicao(req),
      }));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// POST /api/operador/tenants/:id/reativar
router.post('/tenants/:id/reativar', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.json(await tenants.alterarStatus({
      operador: req.operador, tenantId: id, status: 'ativo',
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// POST /api/operador/tenants/:id/acesso-suporte  { motivo? }
//
// Troca a credencial de operador por uma sessão CURTA e SOMENTE-LEITURA dentro
// de UM tenant. O token devolvido é um token de TENANT (assinado com o segredo
// do painel do cliente) com `tenantId` + `suporte: true` — é o "tenant
// explicitamente selecionado" que o ticket exige: a sessão de operador crua,
// sem tenant, não entra em rota de tenant nenhuma.
//
// O perfil dessa sessão é AUDITOR (somente-leitura, sem `atendenteId`) — ver
// auth/rbac.js. O operador diagnostica; não fala com o cliente final pelo
// WhatsApp da empresa nem altera cadastro.
//
// A entrada fica registrada nas DUAS trilhas — inclusive na `auditoria` do
// próprio cliente, que ele lê no painel dele.
// ---------------------------------------------------------------------------
router.post(
  '/tenants/:id/acesso-suporte',
  body('motivo').optional({ nullable: true }).isString().isLength({ max: 200 }).trim(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    if (checarValidacao(req, res)) return;
    const expiraEm = new Date(Date.now() + SUPORTE_TTL_MIN * 60_000);
    try {
      const t = await tenants.abrirAcessoSuporte({
        operador: req.operador, tenantId: id, motivo: req.body.motivo,
        expiraEm, ip: auditoria.ipDaRequisicao(req),
      });
      const token = jwt.sign(
        {
          jti: crypto.randomUUID(),
          tenantId: t.id,
          suporte: true,
          operadorId: req.operador.id,
          nome: `Suporte Falatta (${req.operador.email})`,
          email: req.operador.email,
        },
        SECRET_TENANT,
        { expiresIn: `${SUPORTE_TTL_MIN}m` }
      );
      res.json({ token, tenant: t, expiraEm: expiraEm.toISOString(), papel: 'AUDITOR' });
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/operador/auditoria?tenantId=&limite= — trilha do operador.
// ---------------------------------------------------------------------------
router.get(
  '/auditoria',
  query('tenantId').optional({ nullable: true }).isInt({ min: 1 }),
  query('limite').optional({ nullable: true }).isInt({ min: 1, max: 500 }),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    try {
      const rows = await tenants.listarAuditoria({
        tenantId: req.query.tenantId ? Number(req.query.tenantId) : null,
        limite: req.query.limite ? Number(req.query.limite) : 100,
      });
      res.json(mapRows(rows));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

module.exports = router;
