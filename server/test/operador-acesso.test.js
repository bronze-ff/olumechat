// Testes da FRONTEIRA DE SESSÃO do painel do operador (FIL-70).
//
// Este painel enxerga todos os tenants — é o alvo mais valioso do sistema.
// Critérios de aceite cobertos aqui:
//  • JWT de ADMIN de tenant recebe 403 em TODA rota /api/operador/* (a lista
//    de rotas é lida do próprio router, então rota nova entra no teste
//    sozinha);
//  • JWT de operador NÃO é aceito nas rotas de tenant sem um tenant
//    explicitamente selecionado — e a seleção explícita é a sessão de
//    implantação, administrativa, auditada e limitada a um tenant;
//  • login de operador com 401 uniforme, sem vazar senha, com rate-limit;
//  • operador desativado no banco perde o acesso na hora, sem esperar o JWT
//    expirar.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
// Estes testes exercitam o singleton em memória. Uma DATABASE_URL_DIRECT do
// ambiente de desenvolvimento faria publish() sair pelo Postgres real e
// tornaria o resultado dependente da conexão externa e do tempo de LISTEN.
process.env.DATABASE_URL_DIRECT = '';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const senhas = require('../auth/senha');
const rbac = require('../auth/rbac');
const authMiddleware = require('../auth/middleware');
const authRoutes = require('../auth/routes');
const streamRoutes = require('../api/stream');
const presence = require('../realtime/presence');
const { publish } = require('../realtime/hub');
const operadorRoutes = require('../operador/routes');
const { SECRET: SECRET_TENANT } = require('../auth/secret');
const { SECRET: SECRET_OPERADOR } = require('../operador/segredo');

const SENHA_OPERADOR = 'senha-do-operador-2026';
const TENANT_ID = 4;

// ---------------------------------------------------------------------------
// Banco em memória (só o que a fronteira de sessão toca).
// ---------------------------------------------------------------------------
let estado;
function instalarBanco() {
  estado = {
    operadores: [],
    tenants: [{ ID: TENANT_ID, NOME: 'Acme', SLUG: 'acme', STATUS: 'ativo' }],
    auditoriaOperador: [],
    auditoriaTenant: [],
    blacklist: new Set(),
  };
  const conn = {
    async execute(sql, binds = {}) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/set_config/.test(s)) return { rows: [] };
      if (/^DELETE FROM token_blacklist WHERE expira_em <= now\(\)/i.test(s)) {
        return { rowsAffected: 0, rows: [] };
      }
      if (/^SELECT 1 FROM token_blacklist WHERE jti = :jti/i.test(s)) {
        return { rows: estado.blacklist.has(String(binds.jti)) ? [{ 1: 1 }] : [] };
      }
      if (/^INSERT INTO token_blacklist/i.test(s)) {
        estado.blacklist.add(String(binds.jti));
        return { rowsAffected: 1, rows: [] };
      }
      if (/^SELECT id, email, nome, senha_hash, ativo FROM operador WHERE email/i.test(s)) {
        const o = estado.operadores.find((x) => x.EMAIL === binds.email);
        return { rows: o ? [{ ...o }] : [] };
      }
      if (/^SELECT id, email, nome FROM operador WHERE id = :id AND ativo = 'S'/i.test(s)) {
        const o = estado.operadores.find((x) => x.ID === Number(binds.id) && x.ATIVO === 'S');
        return { rows: o ? [{ ID: o.ID, EMAIL: o.EMAIL, NOME: o.NOME }] : [] };
      }
      if (/^UPDATE operador SET ultimo_acesso_em/i.test(s)) return { rowsAffected: 1, rows: [] };
      if (/^SELECT id, nome, slug, status FROM tenant WHERE id = :id/i.test(s)) {
        const t = estado.tenants.find((x) => x.ID === Number(binds.id));
        return { rows: t ? [{ ...t }] : [] };
      }
      if (/^SELECT ia_habilitada FROM tenant WHERE id = :id/i.test(s)) {
        return { rows: [{ IA_HABILITADA: 'S' }] };
      }
      if (/^INSERT INTO operador_auditoria/i.test(s)) {
        estado.auditoriaOperador.push({ ACAO: binds.acao, TENANT_ID: binds.tenantId });
        return { rowsAffected: 1, rows: [] };
      }
      if (/^INSERT INTO auditoria/i.test(s)) {
        estado.auditoriaTenant.push({ ACAO: binds.acao, TENANT_ID: binds.tenantId });
        return { rowsAffected: 1, rows: [] };
      }
      if (/FROM operador_auditoria/i.test(s)) return { rows: [] };
      if (/FROM tenant t/i.test(s)) return { rows: [] };
      // Perfil RBAC de um usuário LEGÍTIMO do tenant (o do suporte não passa
      // por aqui — é justamente o que o teste do /perfil guarda).
      if (/^SELECT id, papel, ativo, status_presenca, pode_ativo FROM atendente/i.test(s)) {
        return { rows: [{ ID: 7, PAPEL: 'ADMIN', ATIVO: 'S', STATUS_PRESENCA: 'offline', PODE_ATIVO: 'S' }] };
      }
      if (/FROM atendente_depto|FROM atendente_numero/i.test(s)) return { rows: [] };
      throw new Error(`SQL não previsto no banco de teste: ${s}`);
    },
    async commit() {}, async rollback() {}, async close() {},
  };
  db.getConnection = async () => conn;
  db.comTenant = async (tenantId, fn) => fn(conn);
}

// ---------------------------------------------------------------------------
// App: painel do operador + uma rota de TENANT (para provar que um token não
// atravessa para o lado do outro).
// ---------------------------------------------------------------------------
function startApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api', express.json());
  app.use('/api/operador', operadorRoutes);
  // Cadeia de tenant idêntica à do app.js.
  app.get('/api/conversas', authMiddleware, rbac.anexarPerfil, (req, res) =>
    res.json({ tenantId: req.tenantId, papel: req.perfil.papel, atendenteId: req.perfil.atendenteId }));
  app.post('/api/atendentes/1', authMiddleware, rbac.anexarPerfil, rbac.exigirPapel('ADMIN'), (req, res) =>
    res.json({ ok: true }));
  // Rotas de mutação SEM guarda de papel — existem de verdade no repo.
  // A auditoria central precisa registrar até estas operações.
  const executou = (req, res) => { mutacoesExecutadas.push(`${req.method} ${req.originalUrl}`); res.json({ ok: true }); };
  app.post('/api/atalhos', authMiddleware, rbac.anexarPerfil, executou);
  app.delete('/api/atalhos/1', authMiddleware, rbac.anexarPerfil, executou);
  app.put('/api/presenca', authMiddleware, rbac.anexarPerfil, executou);
  app.get('/api/atalhos', authMiddleware, rbac.anexarPerfil, (req, res) => res.json([]));
  // Provisionamento de canal — as ÚNICAS mutações da allowlist de suporte
  // (exigirSuporteOperador em api/numeros.js e api/meta.js). Caminho real,
  // handler falso: aqui o que importa é o deny central, não o provisionamento.
  app.post('/api/numeros', authMiddleware, rbac.anexarPerfil, executou);
  app.put('/api/numeros/1', authMiddleware, rbac.anexarPerfil, executou);
  app.post('/api/numeros/1/registrar', authMiddleware, rbac.anexarPerfil, executou);
  app.post('/api/numeros/1/registrar-extra', authMiddleware, rbac.anexarPerfil, executou);
  app.post('/api/meta/signup/exchange', authMiddleware, rbac.anexarPerfil, executou);
  app.use('/api/auth', authRoutes);
  app.use('/api/stream', streamRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function req(port, method, path, { body, tok, ip = '10.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      { method, hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip,
                   ...(tok ? { authorization: `Bearer ${tok}` } : {}),
                   ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let o = '';
        res.on('data', (c) => (o += c));
        res.on('end', () => {
          let corpo = {};
          try { corpo = JSON.parse(o || '{}'); } catch { /* resposta não-JSON */ }
          resolve({ status: res.statusCode, texto: o, body: corpo });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const tokenTenant = (extra = {}) => jwt.sign(
  { jti: `t-${Math.random()}`, tenantId: TENANT_ID, usuarioId: 10, matricula: 10, nome: 'Ana', ...extra },
  SECRET_TENANT, { expiresIn: '1h' });
const tokenOperador = (extra = {}) => jwt.sign(
  { jti: `o-${Math.random()}`, escopo: 'operador', operadorId: 1, email: 'op@falatta.test', ...extra },
  SECRET_OPERADOR, { expiresIn: '1h' });

/**
 * Rotas do painel do operador, lidas do próprio router. Rota nova cai neste
 * teste sem ninguém lembrar de listá-la aqui.
 */
function rotasDoOperador() {
  return operadorRoutes.stack
    .filter((camada) => camada.route)
    .flatMap((camada) => Object.keys(camada.route.methods)
      .filter((m) => m !== '_all')
      .map((metodo) => ({ metodo: metodo.toUpperCase(), caminho: camada.route.path })))
    .filter((r) => r.caminho !== '/login'); // login é por credencial, não por token
}

let mutacoesExecutadas = [];
let ctx;
let HASH;
test.before(async () => {
  HASH = await senhas.gerarHash(SENHA_OPERADOR);
  ctx = await startApp();
});
test.after(() => ctx && ctx.server.close());
test.beforeEach(() => {
  instalarBanco();
  rbac.invalidar(); // o perfil tem cache de 30s e os testes reusam a matrícula
  mutacoesExecutadas = [];
  estado.operadores.push({ ID: 1, EMAIL: 'op@falatta.test', NOME: 'Operador', SENHA_HASH: HASH, ATIVO: 'S' });
});

/** Abre uma sessão de suporte no tenant e devolve o token dela. */
async function tokenDeSuporte() {
  const r = await req(ctx.port, 'POST', `/api/operador/tenants/${TENANT_ID}/acesso-suporte`, { tok: tokenOperador() });
  assert.equal(r.status, 200, r.texto);
  return r.body.token;
}

// ===========================================================================
// AC: JWT de ADMIN de tenant → 403 em TODA rota /api/operador/*.
// ===========================================================================
test('JWT de ADMIN de tenant recebe 403 em TODA rota do painel do operador', async () => {
  const rotas = rotasDoOperador();
  assert.ok(rotas.length >= 8, `o painel deveria ter mais rotas — só ${rotas.length} foram descobertas`);

  for (const { metodo, caminho } of rotas) {
    const path = `/api/operador${caminho.replace(':id', String(TENANT_ID))}`;
    const r = await req(ctx.port, metodo, path, { tok: tokenTenant(), body: metodo === 'GET' ? undefined : {} });
    assert.equal(r.status, 403, `${metodo} ${path} devolveu ${r.status} para um ADMIN de tenant`);
    assert.equal(estado.auditoriaOperador.length, 0, `${metodo} ${path} chegou a EXECUTAR com token de tenant`);
  }
});

test('403 vale para qualquer papel de tenant, não só ADMIN', async () => {
  for (const papel of ['ADMIN', 'SUPERVISOR', 'ATENDENTE', 'AUDITOR']) {
    const r = await req(ctx.port, 'GET', '/api/operador/tenants', { tok: tokenTenant({ papel }) });
    assert.equal(r.status, 403, `papel ${papel} devolveu ${r.status}`);
  }
});

test('token de tenant não vira token de operador só por trocar o claim', async () => {
  // Assinado com o segredo do TENANT, mas se dizendo operador.
  const forjado = jwt.sign({ jti: 'x', escopo: 'operador', operadorId: 1, tenantId: TENANT_ID },
    SECRET_TENANT, { expiresIn: '1h' });
  const r = await req(ctx.port, 'GET', '/api/operador/tenants', { tok: forjado });
  assert.equal(r.status, 403);

  // Sem tenantId e assinado com o segredo errado: nem identificação existe → 401.
  const semTenant = jwt.sign({ jti: 'y', escopo: 'operador', operadorId: 1 }, SECRET_TENANT, { expiresIn: '1h' });
  assert.equal((await req(ctx.port, 'GET', '/api/operador/tenants', { tok: semTenant })).status, 401);
});

test('sem token, token de outro emissor, "none" e expirado → 401 no painel do operador', async () => {
  assert.equal((await req(ctx.port, 'GET', '/api/operador/tenants')).status, 401);
  const outro = jwt.sign({ escopo: 'operador', operadorId: 1 }, 'segredo-do-atacante', { expiresIn: '1h' });
  assert.equal((await req(ctx.port, 'GET', '/api/operador/tenants', { tok: outro })).status, 401);
  const none = jwt.sign({ escopo: 'operador', operadorId: 1 }, '', { algorithm: 'none' });
  assert.equal((await req(ctx.port, 'GET', '/api/operador/tenants', { tok: none })).status, 401);
  const expirado = jwt.sign({ escopo: 'operador', operadorId: 1 }, SECRET_OPERADOR, { expiresIn: '-1s' });
  assert.equal((await req(ctx.port, 'GET', '/api/operador/tenants', { tok: expirado })).status, 401);
});

test('token de operador sem o claim de escopo é recusado', async () => {
  const semEscopo = jwt.sign({ jti: 'z', operadorId: 1 }, SECRET_OPERADOR, { expiresIn: '1h' });
  assert.equal((await req(ctx.port, 'GET', '/api/operador/tenants', { tok: semEscopo })).status, 401);
});

test('operador desativado no banco perde o acesso na hora (sem esperar o JWT expirar)', async () => {
  const tok = tokenOperador();
  assert.equal((await req(ctx.port, 'GET', '/api/operador/eu', { tok })).status, 200);
  estado.operadores[0].ATIVO = 'N';
  assert.equal((await req(ctx.port, 'GET', '/api/operador/eu', { tok })).status, 401);
});

// ===========================================================================
// AC: JWT de operador não é aceito nas rotas de tenant sem tenant selecionado.
// ===========================================================================
test('JWT de operador NÃO entra em rota de tenant — não há tenant selecionado', async () => {
  const r = await req(ctx.port, 'GET', '/api/conversas', { tok: tokenOperador() });
  assert.equal(r.status, 401, 'um token sem tenant não pode cair num tenant qualquer');
});

test('nem com um tenantId enfiado no token de operador (o segredo é outro)', async () => {
  const r = await req(ctx.port, 'GET', '/api/conversas', { tok: tokenOperador({ tenantId: TENANT_ID }) });
  assert.equal(r.status, 401, 'token assinado com o segredo do operador não vale no painel do cliente');
});

// ===========================================================================
// Acesso de suporte: a ÚNICA forma de o operador entrar num tenant.
// ===========================================================================
test('acesso de suporte devolve ADMIN temporário do tenant escolhido e auditado', async () => {
  const r = await req(ctx.port, 'POST', `/api/operador/tenants/${TENANT_ID}/acesso-suporte`,
    { tok: tokenOperador(), body: { motivo: 'chamado #9' } });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.body.papel, 'ADMIN');

  const p = jwt.decode(r.body.token);
  assert.equal(p.tenantId, TENANT_ID, 'a sessão de suporte é escopada a UM tenant');
  assert.equal(p.suporte, true);
  assert.equal(p.operadorId, 1, 'a sessão carrega de quem ela é');
  assert.equal(p.matricula, undefined, 'suporte não vira funcionário do cliente');
  assert.ok(p.exp - p.iat <= 60 * 60, 'sessão de suporte tem que ser curta');

  // Registrada nas duas trilhas — inclusive na que o cliente lê.
  assert.equal(estado.auditoriaOperador.filter((a) => a.ACAO === 'acesso_suporte').length, 1);
  assert.equal(estado.auditoriaTenant.filter((a) => a.ACAO === 'acesso_suporte').length, 1);

  // Ela ENTRA no painel do cliente com visibilidade de ADMIN...
  const leitura = await req(ctx.port, 'GET', '/api/conversas', { tok: r.body.token });
  assert.equal(leitura.status, 200);
  assert.equal(leitura.body.tenantId, TENANT_ID);
  assert.equal(leitura.body.papel, 'ADMIN');
  assert.equal(leitura.body.atendenteId, null, 'o operador não pode virar autor de nada no tenant');

  // ...mas o perfil ADMIN não basta: o deny central de suporte barra a
  // escrita em rota fora da allowlist, mesmo numa rota que exige ADMIN.
  const escrita = await req(ctx.port, 'POST', '/api/atendentes/1', { tok: r.body.token, body: { papel: 'ADMIN' } });
  assert.equal(escrita.status, 403);
  assert.ok(
    estado.auditoriaTenant.some((item) => item.ACAO === 'suporte_mutacao'),
    'a tentativa de escrita precisa aparecer na auditoria do cliente mesmo bloqueada'
  );

  // ...e NÃO volta a valer no painel do operador.
  const volta = await req(ctx.port, 'GET', '/api/operador/tenants', { tok: r.body.token });
  assert.equal(volta.status, 403, 'a sessão de suporte não pode reabrir a porta do operador');
});

// ---------------------------------------------------------------------------
// Somente-leitura do suporte: imposto CENTRALMENTE, não rota a rota.
// ---------------------------------------------------------------------------
test('suporte é bloqueado em mutação de rota SEM guarda de papel (o deny é central)', async () => {
  const tok = await tokenDeSuporte();
  // Estas três não têm exigirPapel nem o guarda de AUDITOR no repo real —
  // se o bloqueio dependesse da rota, passariam.
  const casos = [
    ['POST', '/api/atalhos', { atalho: 'oi', conteudo: 'texto' }],
    ['DELETE', '/api/atalhos/1', undefined],
    ['PUT', '/api/presenca', { estado: 'online' }],
  ];
  for (const [metodo, rota, body] of casos) {
    const r = await req(ctx.port, metodo, rota, { tok, body });
    assert.equal(r.status, 403, `${metodo} ${rota} devolveu ${r.status} para uma sessão de suporte`);
  }
  assert.deepEqual(mutacoesExecutadas, [], 'a mutação chegou a EXECUTAR com sessão de suporte');
  // A tentativa bloqueada também fica auditada — o cliente precisa enxergar
  // o que o operador tentou, mesmo o que foi negado.
  assert.equal(
    estado.auditoriaTenant.filter((item) => item.ACAO === 'suporte_mutacao').length,
    3
  );
});

test('o mesmo bloqueio não atinge o usuário legítimo do tenant', async () => {
  const r = await req(ctx.port, 'POST', '/api/atalhos', { tok: tokenTenant(), body: { atalho: 'oi' } });
  assert.equal(r.status, 200, 'o deny do suporte não pode pegar quem é do cliente');
  assert.equal(mutacoesExecutadas.length, 1);
});

test('suporte lê normalmente e mantém logout e ticket de SSE', async () => {
  const tok = await tokenDeSuporte();
  assert.equal((await req(ctx.port, 'GET', '/api/atalhos', { tok })).status, 200);
  assert.equal((await req(ctx.port, 'POST', '/api/stream/ticket', { tok })).status, 200, 'sem ticket não há SSE para diagnosticar');
  assert.equal((await req(ctx.port, 'POST', '/api/auth/logout', { tok })).status, 200, 'encerrar a própria sessão tem que continuar possível');
});

test('a allowlist libera o provisionamento de canal, que EXIGE sessão de suporte', async () => {
  const tok = await tokenDeSuporte();
  const casos = [
    ['POST', '/api/numeros'],
    ['PUT', '/api/numeros/1'],
    ['POST', '/api/numeros/1/registrar'],
    ['POST', '/api/meta/signup/exchange'],
  ];
  for (const [metodo, rota] of casos) {
    const r = await req(ctx.port, metodo, rota, { tok, body: {} });
    assert.equal(r.status, 200, `${metodo} ${rota} devolveu ${r.status} para sessão de suporte`);
  }
  assert.deepEqual(mutacoesExecutadas, [
    'POST /api/numeros',
    'PUT /api/numeros/1',
    'POST /api/numeros/1/registrar',
    'POST /api/meta/signup/exchange',
  ]);
});

test('a allowlist do suporte não abre por prefixo, query string ou barra final', async () => {
  const tok = await tokenDeSuporte();
  const casos = [
    ['POST', '/api/numeros/1/registrar-extra'], // sufixo do caminho liberado (prefixo não conta)
    ['POST', '/api/atalhos?x=1'],               // query string não libera rota bloqueada
    ['POST', '/api/atalhos/'],                  // barra final não libera rota bloqueada
  ];
  for (const [metodo, rota] of casos) {
    const r = await req(ctx.port, metodo, rota, { tok, body: {} });
    assert.equal(r.status, 403, `${metodo} ${rota} devolveu ${r.status} — a allowlist casou por engano`);
  }
  assert.deepEqual(mutacoesExecutadas, [], 'alguma variante da allowlist chegou a EXECUTAR');
});

test('leitura e ticket SSE não poluem a auditoria de mutações', () => {
  assert.equal(authMiddleware.mutacaoDeSuporte({ method: 'GET', originalUrl: '/api/conversas' }), false);
  assert.equal(authMiddleware.mutacaoDeSuporte({ method: 'HEAD', originalUrl: '/api/conversas' }), false);
  assert.equal(authMiddleware.mutacaoDeSuporte({ method: 'POST', originalUrl: '/api/stream/ticket' }), false);
  assert.equal(authMiddleware.mutacaoDeSuporte({ method: 'POST', originalUrl: '/api/fluxos' }), true);
});

// ---------------------------------------------------------------------------
// Perfil: o reload da página do cliente durante o suporte não pode dar 500.
// ---------------------------------------------------------------------------
test('GET /api/auth/perfil com token de suporte responde ADMIN sem criar atendente', async () => {
  const tok = await tokenDeSuporte();
  const r = await req(ctx.port, 'GET', '/api/auth/perfil', { tok });
  // 500 aqui = o endpoint mandou a sessão de suporte para carregarPerfil, que
  // tentaria criar um `atendente` com matrícula indefinida (o banco de teste
  // estoura em SQL não previsto justamente para denunciar isso).
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.body.papel, 'ADMIN');
  assert.equal(r.body.atendenteId, null);
  assert.equal(r.body.suporte, true, 'o front precisa saber que está em sessão de suporte para se marcar');
  assert.equal(r.body.podeAtivo, true);
  assert.equal(r.body.iaHabilitada, true);
});

test('no SSE, a sessão de suporte não vira atendente nem entra na presença do cliente', async () => {
  presence._reset();
  const acesso = await req(ctx.port, 'POST', `/api/operador/tenants/${TENANT_ID}/acesso-suporte`, { tok: tokenOperador() });
  const ticket = (await req(ctx.port, 'POST', '/api/stream/ticket', { tok: acesso.body.token })).body.ticket;
  assert.ok(ticket);

  const recebido = [];
  const cliente = http.get({ hostname: '127.0.0.1', port: ctx.port, path: `/api/stream?ticket=${ticket}` }, (res) => {
    // 500 aqui = alguém mandou a sessão de suporte para o carregarPerfil, que
    // tentaria criar um `atendente` com matrícula nula.
    assert.equal(res.statusCode, 200);
    res.setEncoding('utf8');
    res.on('data', (c) => recebido.push(c));
  });
  cliente.on('error', () => {}); // destroy() no fim pode gerar ECONNRESET

  await new Promise((r) => setTimeout(r, 100));
  publish({ tipo: 'atribuicao', tenantId: TENANT_ID, conversaId: 555, departamentoId: null });
  await new Promise((r) => setTimeout(r, 100));
  cliente.destroy();

  assert.ok(recebido.join('').includes('"conversaId":555'), 'o suporte precisa enxergar o tempo real para diagnosticar');
  assert.deepEqual(presence.snapshot(), [], 'o operador apareceu como atendente disponível no painel do cliente');
});

// ===========================================================================
// Login do operador.
// ===========================================================================
test('login de operador devolve token com escopo próprio e SEM tenantId', async () => {
  const r = await req(ctx.port, 'POST', '/api/operador/login',
    { body: { email: 'op@falatta.test', senha: SENHA_OPERADOR }, ip: '10.1.0.1' });
  assert.equal(r.status, 200, r.texto);
  const p = jwt.decode(r.body.token);
  assert.equal(p.escopo, 'operador');
  assert.equal(p.operadorId, 1);
  assert.equal(p.tenantId, undefined, 'token de operador com tenant seria um ADMIN disfarçado');
  assert.ok(p.jti, 'sem jti o logout não teria o que revogar');

  // O token do operador é assinado com OUTRO segredo — o do tenant não o abre.
  assert.throws(() => jwt.verify(r.body.token, SECRET_TENANT));
});

test('401 uniforme: e-mail inexistente, conta desativada e senha errada respondem igual', async () => {
  estado.operadores.push({ ID: 2, EMAIL: 'ex@falatta.test', NOME: 'Ex', SENHA_HASH: HASH, ATIVO: 'N' });
  const casos = {
    'e-mail inexistente': { email: 'ninguem@falatta.test', senha: SENHA_OPERADOR },
    'conta desativada': { email: 'ex@falatta.test', senha: SENHA_OPERADOR },
    'senha errada': { email: 'op@falatta.test', senha: 'errada-de-proposito' },
  };
  const respostas = [];
  let i = 0;
  for (const [nome, body] of Object.entries(casos)) {
    const r = await req(ctx.port, 'POST', '/api/operador/login', { body, ip: `10.2.0.${++i}` });
    assert.equal(r.status, 401, `${nome} deveria ser 401`);
    respostas.push([nome, r.texto]);
  }
  for (const [nome, texto] of respostas) {
    assert.equal(texto, respostas[0][1], `a resposta de "${nome}" difere — vaza qual foi o motivo`);
  }
});

test('a senha do operador não aparece na resposta nem no console', async () => {
  const SEGREDO = 'ABRACADABRA-2026-nao-pode-vazar';
  const linhas = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(' '));
  let respostas;
  try {
    respostas = [
      await req(ctx.port, 'POST', '/api/operador/login', { body: { email: 'op@falatta.test', senha: SENHA_OPERADOR }, ip: '10.3.0.1' }),
      await req(ctx.port, 'POST', '/api/operador/login', { body: { email: 'op@falatta.test', senha: SEGREDO }, ip: '10.3.0.2' }),
      await req(ctx.port, 'POST', '/api/operador/login', { body: { email: 'op@falatta.test', senha: SEGREDO.repeat(20) }, ip: '10.3.0.3' }),
    ];
  } finally { Object.assign(console, orig); }

  assert.deepEqual(respostas.map((r) => r.status), [200, 401, 400]);
  for (const r of respostas) {
    assert.equal(r.texto.includes(SEGREDO), false, `senha vazou na resposta: ${r.texto}`);
    assert.equal(r.texto.includes(SENHA_OPERADOR), false, `senha vazou na resposta: ${r.texto}`);
    assert.equal(r.texto.includes('argon2'), false, 'o hash não pode sair na resposta');
  }
  const log = linhas.join('\n');
  assert.equal(log.includes(SEGREDO), false, `senha vazou no console: ${log}`);
  assert.equal(log.includes(SENHA_OPERADOR), false, `senha vazou no console: ${log}`);
});

test('rate-limit do login de operador (11ª tentativa do mesmo IP → 429)', async () => {
  const IP = '10.9.9.10';
  let ultima;
  for (let i = 0; i < 11; i++) {
    ultima = await req(ctx.port, 'POST', '/api/operador/login',
      { body: { email: 'op@falatta.test', senha: 'errada-de-proposito' }, ip: IP });
  }
  assert.equal(ultima.status, 429);
  assert.ok(ultima.body.error, 'o 429 precisa vir em JSON com `error`');
});

test('logout revoga o jti: o mesmo token não vale mais', async () => {
  const login = await req(ctx.port, 'POST', '/api/operador/login',
    { body: { email: 'op@falatta.test', senha: SENHA_OPERADOR }, ip: '10.4.0.1' });
  const tok = login.body.token;
  assert.equal((await req(ctx.port, 'GET', '/api/operador/eu', { tok })).status, 200);
  assert.equal((await req(ctx.port, 'POST', '/api/operador/logout', { tok })).status, 200);
  assert.equal((await req(ctx.port, 'GET', '/api/operador/eu', { tok })).status, 401);
});
