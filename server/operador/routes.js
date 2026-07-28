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
const credencialIa = require('./credencialIa');
const consumo = require('./consumo');
const contrato = require('./contrato');
const implementacao = require('./implementacao');
const fatura = require('./fatura');
const precos = require('../consumo/precos');
const iaConfigStore = require('../ia/iaConfigStore');
const { trocarCodigo } = require('../api/meta');
const { guardar } = require('../meta/connection');
const { linkDeConvite } = require('../utils/conviteLink');

const router = express.Router();

/** Resposta única de credencial recusada (mesmo racional do login de tenant). */
const MSG_401 = 'Usuário ou senha inválidos.';

/** Minutos de validade da sessão de SUPORTE dentro de um tenant. */
const SUPORTE_TTL_MIN = Number(process.env.OPERADOR_SUPORTE_TTL_MIN) || 30;

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

// Fallback do operador quando o cliente trava no Embedded Signup. O operador
// escolhe explicitamente o tenant; nunca criamos tenant a partir do webhook.
router.post('/tenants/:id/meta/signup/exchange', async (req, res, next) => {
  const tenantId = Number(req.params.id);
  const { code, wabaId, phoneNumberId, displayPhone, nomeExibicao } = req.body || {};
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !code || !phoneNumberId) {
    return res.status(400).json({ error: 'tenant, code e phoneNumberId são obrigatórios' });
  }
  try {
    const meta = await trocarCodigo(code);
    await comOperador(async (conn) => {
      await guardar({ tenantId, accessToken: meta.access_token, wabaId, conn });
      await conn.execute(
        `INSERT INTO numero (tenant_id, phone_number_id, display_phone, nome_exibicao, waba_id)
         VALUES (:tenantId, :phone, :displayPhone, :nome, :waba)
         ON CONFLICT (phone_number_id) DO UPDATE SET display_phone = COALESCE(EXCLUDED.display_phone, numero.display_phone),
           nome_exibicao = COALESCE(EXCLUDED.nome_exibicao, numero.nome_exibicao), waba_id = COALESCE(EXCLUDED.waba_id, numero.waba_id)`,
        { tenantId, phone: String(phoneNumberId), displayPhone: displayPhone || null, nome: nomeExibicao || null, waba: wabaId || null });
    });
    res.status(201).json({ ok: true, status: 'conectada', tenantId, phoneNumberId: String(phoneNumberId) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/operador/logout — jti na blacklist.
// ---------------------------------------------------------------------------
router.post('/logout', async (req, res, next) => {
  try {
    if (req.operador.jti) await blacklist.add(req.operador.jti, req.operador.exp, { operador: true });
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
// Troca a credencial de operador por uma sessão CURTA e escopada dentro
// de UM tenant. O token devolvido é um token de TENANT (assinado com o segredo
// do painel do cliente) com `tenantId` + `suporte: true` — é o "tenant
// explicitamente selecionado" que o ticket exige: a sessão de operador crua,
// sem tenant, não entra em rota de tenant nenhuma.
//
// O perfil dessa sessão é ADMIN de implantação (sem `atendenteId`) — ver
// auth/rbac.js. O operador configura o tenant inteiro, mas não vira funcionário
// do cliente, não entra na presença e não recebe conversas da fila.
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
      res.json({ token, tenant: t, expiraEm: expiraEm.toISOString(), papel: 'ADMIN' });
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/operador/tenants/:id/ia  { habilitada: bool }
// Liga/desliga o add-on de IA no plano do cliente — é o único jeito de
// habilitar (o admin do tenant não tem esse botão, ver api/iaConfig.js).
// ---------------------------------------------------------------------------
router.post(
  '/tenants/:id/ia',
  body('habilitada').isBoolean(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    if (checarValidacao(req, res)) return;
    try {
      res.json(await tenants.definirIa({
        operador: req.operador, tenantId: id, habilitada: req.body.habilitada === true,
        ip: auditoria.ipDaRequisicao(req),
      }));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/operador/tenants/:id/ia-config — status atual (sem a chave).
// PUT  /api/operador/tenants/:id/ia-config  { provider, modelo, baseUrl?, apiKey? }
// Só o operador define provider/modelo/chave de um cliente — é o add-on
// vendido à parte (ver cabeçalho de operador/tenants.js::salvarIaConfig).
// ---------------------------------------------------------------------------
router.get('/tenants/:id/ia-config', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.json(await tenants.carregarIaConfig(id));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.put(
  '/tenants/:id/ia-config',
  body('provider').isString(),
  body('modelo').isString(),
  body('baseUrl').optional({ nullable: true }).isString(),
  body('apiKey').optional({ nullable: true }).isString(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    if (checarValidacao(req, res)) return;
    try {
      res.json(await tenants.salvarIaConfig({
        operador: req.operador, tenantId: id,
        provider: req.body.provider, modelo: req.body.modelo,
        baseUrl: req.body.baseUrl, apiKey: req.body.apiKey,
        ip: auditoria.ipDaRequisicao(req),
      }));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/operador/tenants/:id/ia-config/desativar — aposenta a chave
// própria do tenant (FIL-78: migração gradual pra credencial global). A
// próxima chamada de IA deste tenant já usa a credencial do operador.
// ---------------------------------------------------------------------------
router.post('/tenants/:id/ia-config/desativar', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.json(await tenants.desativarIaConfig({ operador: req.operador, tenantId: id, ip: auditoria.ipDaRequisicao(req) }));
  } catch (err) {
    tratar(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// POST /api/operador/tenants/:id/ia-teto  { tetoTokensMes: number|null }
// Define o teto mensal de tokens do add-on de IA do tenant (null = sem
// teto). Ver ia/limitePlano.js — quem INCREMENTA o consumo é o FIL-77.
// ---------------------------------------------------------------------------
router.post(
  '/tenants/:id/ia-teto',
  body('tetoTokensMes').optional({ nullable: true }).isInt({ min: 0 }).toInt(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    if (checarValidacao(req, res)) return;
    try {
      const tetoTokensMes = req.body.tetoTokensMes === undefined ? null : req.body.tetoTokensMes;
      res.json(await tenants.definirTetoIa({
        operador: req.operador, tenantId: id, tetoTokensMes, ip: auditoria.ipDaRequisicao(req),
      }));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/operador/ia-credencial — credenciais do PROVEDOR configuradas
// (histórico por provider), sem a chave.
// PUT /api/operador/ia-credencial { provider, modeloPadrao, baseUrl?, apiKey? }
// Grava/atualiza e torna esta A credencial ativa (FIL-78: fim da chave por
// tenant — o operador é dono de UMA conta do provedor, compartilhada por
// todos os tenants sem chave própria). Ver operador/credencialIa.js.
// ---------------------------------------------------------------------------
router.get('/ia-credencial', async (req, res, next) => {
  try {
    res.json(await credencialIa.listarCredenciais());
  } catch (err) {
    tratar(err, res, next);
  }
});

router.put(
  '/ia-credencial',
  body('provider').isString(),
  body('modeloPadrao').isString(),
  body('baseUrl').optional({ nullable: true }).isString(),
  body('apiKey').optional({ nullable: true }).isString(),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    try {
      const r = await credencialIa.salvarCredencial({
        operador: req.operador,
        provider: req.body.provider, modeloPadrao: req.body.modeloPadrao,
        baseUrl: req.body.baseUrl, apiKey: req.body.apiKey,
        ip: auditoria.ipDaRequisicao(req),
      });
      // Sem isto, o runtime (ia/iaConfigStore.js) seguiria servindo a
      // credencial antiga do cache até o TTL de 60s expirar sozinho.
      iaConfigStore.invalidarGlobal();
      res.json(r);
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/operador/tenants/:id/consumo?de=&ate= — série de consumo por tipo
// (FIL-77), com custo e quantidade. NUNCA existe equivalente em rota de
// tenant (ver docs/SEGURANCA.md) — só o operador vê custo/tokens/preço.
// ---------------------------------------------------------------------------
router.get('/tenants/:id/consumo', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.json(await consumo.consumoDoTenant({ tenantId: id, de: req.query.de, ate: req.query.ate }));
  } catch (err) {
    tratar(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// GET /api/operador/precos — tabela de preço por provider/modelo (FIL-77).
// PUT /api/operador/precos { provider, modelo, precoEntradaCentavos1k, precoSaidaCentavos1k }
// Editável pelo operador — nunca hardcoded no runtime (ver consumo/precos.js).
// ---------------------------------------------------------------------------
router.get('/precos', async (req, res, next) => {
  try {
    res.json(await precos.listarPrecos());
  } catch (err) {
    tratar(err, res, next);
  }
});

router.put(
  '/precos',
  body('provider').isString(),
  body('modelo').isString(),
  body('precoEntradaCentavos1k').isFloat({ min: 0 }),
  body('precoSaidaCentavos1k').isFloat({ min: 0 }),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    try {
      const r = await precos.salvarPreco({
        operador: req.operador,
        provider: req.body.provider, modelo: req.body.modelo,
        precoEntradaCentavos1k: req.body.precoEntradaCentavos1k,
        precoSaidaCentavos1k: req.body.precoSaidaCentavos1k,
        ip: auditoria.ipDaRequisicao(req),
      });
      res.json(r);
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET  /api/operador/tenants/:id/contrato — histórico de contratos (FIL-76).
// POST /api/operador/tenants/:id/contrato — cria um contrato novo; se já
// existe um ATIVO, encerra-o (fim_vigencia = hoje) e insere o novo na mesma
// transação — é assim que "trocar de plano" funciona (nunca sobrescreve, ver
// operador/contrato.js). Nenhuma rota de tenant expõe isto (ver docs/SEGURANCA.md).
// ---------------------------------------------------------------------------
router.get('/tenants/:id/contrato', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.json(await contrato.listarContratos(id));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.post('/tenants/:id/contrato', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.status(201).json(await contrato.criarOuTrocarContrato({
      operador: req.operador, tenantId: id, dados: req.body || {},
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// Itens do contrato (implementação, add-on de IA, número extra, excedente de
// mensagem, desconto, avulso) — só podem ser alterados enquanto o contrato
// dono ainda está ativo (ver operador/contrato.js::exigirContratoAtivo).
// ---------------------------------------------------------------------------
router.get('/tenants/:id/contrato/:contratoId/itens', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const contratoId = tenants.idValido(req.params.contratoId);
  if (!contratoId) return res.status(400).json({ error: 'ID de contrato inválido' });
  try {
    res.json(await contrato.listarItens({ tenantId: id, contratoId }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.post('/tenants/:id/contrato/:contratoId/itens', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const contratoId = tenants.idValido(req.params.contratoId);
  if (!contratoId) return res.status(400).json({ error: 'ID de contrato inválido' });
  try {
    res.status(201).json(await contrato.adicionarItem({
      operador: req.operador, tenantId: id, contratoId, dados: req.body || {},
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.patch('/tenants/:id/contrato/:contratoId/itens/:itemId', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const contratoId = tenants.idValido(req.params.contratoId);
  const itemId = tenants.idValido(req.params.itemId);
  if (!contratoId || !itemId) return res.status(400).json({ error: 'ID inválido' });
  try {
    res.json(await contrato.atualizarItem({
      operador: req.operador, tenantId: id, contratoId, itemId, dados: req.body || {},
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.delete('/tenants/:id/contrato/:contratoId/itens/:itemId', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const contratoId = tenants.idValido(req.params.contratoId);
  const itemId = tenants.idValido(req.params.itemId);
  if (!contratoId || !itemId) return res.status(400).json({ error: 'ID inválido' });
  try {
    res.json(await contrato.removerItem({
      operador: req.operador, tenantId: id, contratoId, itemId,
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// Implementação (projeto de entrada do cliente) — FIL-76. Ligada ao tenant,
// não ao contrato: sobrevive a uma troca de plano posterior.
// ---------------------------------------------------------------------------
router.get('/tenants/:id/implementacao', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.json(await implementacao.obterImplementacao(id));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.post('/tenants/:id/implementacao', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.status(201).json(await implementacao.criarImplementacao({
      operador: req.operador, tenantId: id, dados: req.body || {},
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.patch('/tenants/:id/implementacao/:implementacaoId', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const implementacaoId = tenants.idValido(req.params.implementacaoId);
  if (!implementacaoId) return res.status(400).json({ error: 'ID inválido' });
  try {
    res.json(await implementacao.atualizarImplementacao({
      operador: req.operador, tenantId: id, implementacaoId, dados: req.body || {},
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

// ---------------------------------------------------------------------------
// Faturamento, pagamentos e inadimplência (FIL-79). Mesma regra de contrato/
// implementação: nenhuma rota de tenant expõe isto (ver docs/SEGURANCA.md).
//
// A geração automática roda 1x/dia em financeiro/faturamento.js::tick (fatura
// `prevista` idempotente por competência). Esta rota só dispara a MESMA
// rotina sob demanda, sem esperar o tick — útil para gerar a fatura do mês
// assim que o operador terminar de configurar um contrato.
// ---------------------------------------------------------------------------
router.post(
  '/faturas/gerar',
  body('competencia').optional({ nullable: true }).isString(),
  body('tenantId').optional({ nullable: true }).isInt({ min: 1 }),
  async (req, res, next) => {
    if (checarValidacao(req, res)) return;
    try {
      res.json(await fatura.gerarManual({
        operador: req.operador, competencia: req.body.competencia,
        tenantId: req.body.tenantId ? Number(req.body.tenantId) : undefined,
        ip: auditoria.ipDaRequisicao(req),
      }));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// GET /api/operador/inadimplencia — faturas atrasadas de todos os tenants.
// A suspensão em si continua ação explícita do operador (POST /tenants/:id/suspender) — nunca automática.
router.get('/inadimplencia', async (req, res, next) => {
  try {
    res.json(await fatura.listarInadimplencia());
  } catch (err) {
    tratar(err, res, next);
  }
});

router.get('/tenants/:id/faturas', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  try {
    res.json(await fatura.listarFaturas(id));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.get('/tenants/:id/faturas/:faturaId', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const faturaId = tenants.idValido(req.params.faturaId);
  if (!faturaId) return res.status(400).json({ error: 'ID de fatura inválido' });
  try {
    res.json(await fatura.obterFatura({ tenantId: id, faturaId }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.get('/tenants/:id/faturas/:faturaId/pagamentos', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const faturaId = tenants.idValido(req.params.faturaId);
  if (!faturaId) return res.status(400).json({ error: 'ID de fatura inválido' });
  try {
    res.json(await fatura.listarPagamentos({ tenantId: id, faturaId }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.post(
  '/tenants/:id/faturas/:faturaId/pagamentos',
  body('valorCentavos').isInt({ min: 1 }),
  body('data').isString(),
  body('meio').isString(),
  body('comprovante').optional({ nullable: true }).isString(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    const faturaId = tenants.idValido(req.params.faturaId);
    if (!faturaId) return res.status(400).json({ error: 'ID de fatura inválido' });
    if (checarValidacao(req, res)) return;
    try {
      res.status(201).json(await fatura.registrarPagamento({
        operador: req.operador, tenantId: id, faturaId, dados: req.body || {},
        ip: auditoria.ipDaRequisicao(req),
      }));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

// Itens manuais (avulso/desconto) — só enquanto a fatura ainda é `prevista`.
router.post('/tenants/:id/faturas/:faturaId/itens', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const faturaId = tenants.idValido(req.params.faturaId);
  if (!faturaId) return res.status(400).json({ error: 'ID de fatura inválido' });
  try {
    res.status(201).json(await fatura.adicionarItem({
      operador: req.operador, tenantId: id, faturaId, dados: req.body || {},
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.delete('/tenants/:id/faturas/:faturaId/itens/:itemId', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const faturaId = tenants.idValido(req.params.faturaId);
  const itemId = tenants.idValido(req.params.itemId);
  if (!faturaId || !itemId) return res.status(400).json({ error: 'ID inválido' });
  try {
    res.json(await fatura.removerItem({
      operador: req.operador, tenantId: id, faturaId, itemId,
      ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.post('/tenants/:id/faturas/:faturaId/emitir', async (req, res, next) => {
  const id = idDaRota(req, res);
  if (!id) return;
  const faturaId = tenants.idValido(req.params.faturaId);
  if (!faturaId) return res.status(400).json({ error: 'ID de fatura inválido' });
  try {
    res.json(await fatura.emitirFatura({
      operador: req.operador, tenantId: id, faturaId, ip: auditoria.ipDaRequisicao(req),
    }));
  } catch (err) {
    tratar(err, res, next);
  }
});

router.post(
  '/tenants/:id/faturas/:faturaId/cancelar',
  body('motivo').optional({ nullable: true }).isString().isLength({ max: 200 }).trim(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    const faturaId = tenants.idValido(req.params.faturaId);
    if (!faturaId) return res.status(400).json({ error: 'ID de fatura inválido' });
    if (checarValidacao(req, res)) return;
    try {
      res.json(await fatura.cancelarFatura({
        operador: req.operador, tenantId: id, faturaId, motivo: req.body.motivo,
        ip: auditoria.ipDaRequisicao(req),
      }));
    } catch (err) {
      tratar(err, res, next);
    }
  }
);

router.post(
  '/tenants/:id/faturas/:faturaId/negociacao',
  body('motivo').optional({ nullable: true }).isString().isLength({ max: 200 }).trim(),
  async (req, res, next) => {
    const id = idDaRota(req, res);
    if (!id) return;
    const faturaId = tenants.idValido(req.params.faturaId);
    if (!faturaId) return res.status(400).json({ error: 'ID de fatura inválido' });
    if (checarValidacao(req, res)) return;
    try {
      res.json(await fatura.marcarEmNegociacao({
        operador: req.operador, tenantId: id, faturaId, motivo: req.body.motivo,
        ip: auditoria.ipDaRequisicao(req),
      }));
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
