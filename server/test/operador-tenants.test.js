// Testes do painel do operador — provisionamento e gestão de tenants (FIL-70).
//
// Critérios de aceite cobertos aqui:
//  • provisionar cria tenant + usuário admin + convite de forma ATÔMICA
//    (falha no meio não deixa tenant órfão);
//  • TODA ação de operador gera registro de auditoria;
//  • suspender um tenant bloqueia o login dos usuários dele e pausa os
//    disparos de campanha;
//  • a listagem traz o uso por tenant.
//
// O "banco" é em memória e serve OS DOIS lados de propósito: o painel do
// operador e o login do cliente (auth/routes.js + auth/tokenSenha.js + RBAC).
// É o que permite testar o ciclo inteiro — provisionar → usar o convite →
// entrar como ADMIN → suspender → não entrar mais — sem Postgres.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.APP_URL = 'https://painel.olume.test';
// O ciclo inteiro abaixo usa o banco transacional em memória. Impede que a
// blacklist compartilhada tente acessar o banco real do ambiente de dev.
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const senhas = require('../auth/senha');
const rbac = require('../auth/rbac');
const authRoutes = require('../auth/routes');
const operadorRoutes = require('../operador/routes');
const dispatcher = require('../campanha/dispatcher');
const { SECRET: SECRET_OPERADOR } = require('../operador/segredo');

const SENHA_OPERADOR = 'senha-do-operador-2026';
const SENHA_ADMIN = 'senha-do-admin-2026';

// ---------------------------------------------------------------------------
// Banco em memória
// ---------------------------------------------------------------------------
function novoEstado() {
  return {
    tenants: [],
    usuarios: [],
    atendentes: [],
    tokensSenha: [],
    operadores: [],
    auditoriaOperador: [], // tabela `operador_auditoria`
    auditoriaTenant: [],   // tabela `auditoria` (a que o cliente lê)
    seq: { tenant: 10, usuario: 100, atendente: 500, aud: 1 },
    falharEm: null,        // regex: SQL que deve estourar (teste de atomicidade)
    conexoes: 0,
    commits: 0,
    rollbacks: 0,
  };
}

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const inicioDoMes = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };

/** Uma "conexão": mantém o contexto de tenant da transação e o log de desfazer. */
function novaConexao(estado, registro) {
  estado.conexoes += 1;
  const undo = [];
  let ctx = { tenant: null };

  function push(lista, linha) {
    lista.push(linha);
    undo.push(() => { const i = lista.indexOf(linha); if (i >= 0) lista.splice(i, 1); });
    return linha;
  }
  function setar(obj, campo, valor) {
    const antes = obj[campo];
    obj[campo] = valor;
    undo.push(() => { obj[campo] = antes; });
  }

  async function execute(sql, binds = {}) {
    const s = norm(sql);
    registro.push({ sql: s, binds, tenantCtx: ctx.tenant });
    if (estado.falharEm && estado.falharEm.test(s)) {
      const err = new Error('falha simulada no meio da transação');
      err.code = 'XXTEST';
      throw err;
    }

    // --- contexto de tenant (set_config transaction-scoped) ---
    if (/set_config\('app\.current_tenant_id'/.test(s)) {
      ctx.tenant = binds.tid ? Number(binds.tid) : null;
      return { rows: [] };
    }

    // --- tenant ---
    if (/^INSERT INTO tenant /i.test(s)) {
      if (estado.tenants.some((t) => t.SLUG === binds.slug)) {
        const err = new Error('duplicate key value violates unique constraint "uq_tenant_slug"');
        err.code = '23505';
        throw err;
      }
      const linha = push(estado.tenants, {
        ID: (estado.seq.tenant += 1), NOME: binds.nome, SLUG: binds.slug,
        STATUS: 'ativo', CRIADO_EM: new Date(),
      });
      return { rows: [{ ...linha }], rowsAffected: 1 };
    }
    if (/^SELECT id, nome, slug, status FROM tenant WHERE id = :id/i.test(s)) {
      const t = estado.tenants.find((x) => x.ID === Number(binds.id));
      return { rows: t ? [{ ID: t.ID, NOME: t.NOME, SLUG: t.SLUG, STATUS: t.STATUS }] : [] };
    }
    if (/^SELECT id FROM tenant WHERE slug = :slug AND status = 'ativo'/i.test(s)) {
      const t = estado.tenants.find((x) => x.SLUG === binds.slug && x.STATUS === 'ativo');
      return { rows: t ? [{ ID: t.ID }] : [] };
    }
    if (/^UPDATE tenant SET nome/i.test(s)) {
      const t = estado.tenants.find((x) => x.ID === Number(binds.id));
      if (t) setar(t, 'NOME', binds.nome);
      return { rowsAffected: t ? 1 : 0, rows: [] };
    }
    if (/^UPDATE tenant SET status/i.test(s)) {
      const t = estado.tenants.find((x) => x.ID === Number(binds.id));
      if (t) setar(t, 'STATUS', binds.status);
      return { rowsAffected: t ? 1 : 0, rows: [] };
    }
    if (/^SELECT t\.id, t\.nome, t\.slug, t\.status/i.test(s)) { // listagem com uso
      const desde = inicioDoMes();
      const rows = [...estado.tenants].sort((a, b) => String(a.NOME).localeCompare(String(b.NOME))).map((t) => ({
        ID: t.ID, NOME: t.NOME, SLUG: t.SLUG, STATUS: t.STATUS, CRIADO_EM: t.CRIADO_EM,
        CONVERSAS_MES: (estado.conversas || []).filter((c) => c.TENANT_ID === t.ID && c.CRIADO_EM >= desde).length,
        MENSAGENS_MES: (estado.mensagens || []).filter((m) => m.TENANT_ID === t.ID && m.DIRECAO === 'out' && m.CRIADO_EM >= desde).length,
        ATENDENTES_ATIVOS: estado.atendentes.filter((a) => a.TENANT_ID === t.ID && a.ATIVO === 'S').length,
        NUMEROS_CONECTADOS: (estado.numeros || []).filter((n) => n.TENANT_ID === t.ID && n.ATIVO === 'S').length,
        USUARIOS_ATIVOS: estado.usuarios.filter((u) => u.TENANT_ID === t.ID && u.ATIVO === 'S').length,
      }));
      return { rows };
    }

    // --- usuario / atendente / token de senha ---
    if (/^INSERT INTO usuario \(/i.test(s)) {
      const linha = push(estado.usuarios, {
        ID: (estado.seq.usuario += 1), TENANT_ID: Number(binds.tenantId), EMAIL: binds.email,
        NOME: binds.nome, SENHA_HASH: null, ATIVO: 'S',
      });
      return { rows: [{ ID: linha.ID, EMAIL: linha.EMAIL, NOME: linha.NOME }], rowsAffected: 1 };
    }
    if (/^INSERT INTO atendente \(/i.test(s)) {
      const linha = push(estado.atendentes, {
        ID: (estado.seq.atendente += 1), TENANT_ID: Number(binds.tenantId),
        MATRICULA: Number(binds.matricula || binds.m), NOME: binds.nome || binds.n || null,
        PAPEL: binds.p || 'ADMIN', ATIVO: 'S', STATUS_PRESENCA: 'offline',
        PODE_ATIVO: 'S',
      });
      return { rows: [{ ID: linha.ID }], outBinds: { id: [linha.ID] }, rowsAffected: 1 };
    }
    if (/^INSERT INTO usuario_token_senha/i.test(s)) {
      push(estado.tokensSenha, {
        TENANT_ID: Number(binds.tenantId), USUARIO_ID: Number(binds.uid),
        TOKEN_HASH: binds.hash, EXPIRA_EM: binds.exp, USADO_EM: null,
      });
      return { rowsAffected: 1, rows: [] };
    }
    if (/^UPDATE usuario_token_senha SET usado_em = now\(\) WHERE tenant_id = :tenantId AND usuario_id/i.test(s)) {
      return { rowsAffected: 0, rows: [] }; // invalidação de tokens anteriores
    }
    if (/^UPDATE usuario_token_senha SET usado_em = now\(\)/i.test(s)) { // consumo (uso único)
      const t = estado.tokensSenha.find((x) => x.TENANT_ID === Number(binds.tenantId)
        && x.TOKEN_HASH === binds.hash && !x.USADO_EM && new Date(x.EXPIRA_EM) > new Date());
      if (!t) return { rowsAffected: 0, rows: [], outBinds: { uid: [undefined] } };
      setar(t, 'USADO_EM', new Date());
      return { rowsAffected: 1, rows: [], outBinds: { uid: [t.USUARIO_ID] } };
    }
    if (/^UPDATE usuario SET senha_hash/i.test(s)) {
      const u = estado.usuarios.find((x) => x.TENANT_ID === Number(binds.tenantId)
        && x.ID === Number(binds.uid) && x.ATIVO === 'S');
      if (!u) return { rowsAffected: 0, rows: [] };
      setar(u, 'SENHA_HASH', binds.hash);
      return { rowsAffected: 1, rows: [] };
    }
    if (/FROM usuario\b/i.test(s) && /WHERE tenant_id = :tenantId AND email = :email/i.test(s)) {
      const u = estado.usuarios.find((x) => x.TENANT_ID === Number(binds.tenantId) && x.EMAIL === binds.email);
      return { rows: u ? [{ ID: u.ID, NOME: u.NOME, EMAIL: u.EMAIL, SENHA_HASH: u.SENHA_HASH, ATIVO: u.ATIVO }] : [] };
    }
    if (/^SELECT id, papel, ativo, status_presenca, pode_ativo FROM atendente/i.test(s)) {
      const a = estado.atendentes.find((x) => x.TENANT_ID === Number(binds.tenantId) && x.MATRICULA === Number(binds.m));
      return { rows: a ? [{ ID: a.ID, PAPEL: a.PAPEL, ATIVO: a.ATIVO, STATUS_PRESENCA: a.STATUS_PRESENCA, PODE_ATIVO: a.PODE_ATIVO }] : [] };
    }
    if (/FROM atendente_depto|FROM atendente_numero/i.test(s)) return { rows: [] };

    // --- operador ---
    if (/^SELECT id, email, nome, senha_hash, ativo FROM operador WHERE email/i.test(s)) {
      const o = estado.operadores.find((x) => x.EMAIL === binds.email);
      return { rows: o ? [{ ...o }] : [] };
    }
    if (/^SELECT id, email, nome FROM operador WHERE id = :id AND ativo = 'S'/i.test(s)) {
      const o = estado.operadores.find((x) => x.ID === Number(binds.id) && x.ATIVO === 'S');
      return { rows: o ? [{ ID: o.ID, EMAIL: o.EMAIL, NOME: o.NOME }] : [] };
    }
    if (/^UPDATE operador SET ultimo_acesso_em/i.test(s)) return { rowsAffected: 1, rows: [] };

    // --- auditoria ---
    if (/^INSERT INTO operador_auditoria/i.test(s)) {
      push(estado.auditoriaOperador, {
        ID: (estado.seq.aud += 1), OPERADOR_ID: binds.opId, OPERADOR_EMAIL: binds.opEmail,
        TENANT_ID: binds.tenantId, ACAO: binds.acao, ENTIDADE: binds.ent,
        ENTIDADE_ID: binds.entId, DETALHE: binds.det, IP: binds.ip, CRIADO_EM: new Date(),
      });
      return { rowsAffected: 1, rows: [] };
    }
    if (/^INSERT INTO auditoria/i.test(s)) {
      push(estado.auditoriaTenant, {
        TENANT_ID: binds.tenantId, ACAO: binds.acao, ENTIDADE: binds.ent,
        ENTIDADE_ID: binds.entId, DETALHE: binds.det, IP: binds.ip,
        CTX: ctx.tenant, CRIADO_EM: new Date(),
      });
      return { rowsAffected: 1, rows: [] };
    }
    if (/FROM operador_auditoria/i.test(s)) {
      const linhas = estado.auditoriaOperador
        .filter((a) => !binds.tenantId || Number(a.TENANT_ID) === Number(binds.tenantId))
        .slice()
        .reverse()
        .slice(0, binds.limite || 100)
        .map((a) => ({ ...a, TENANT_SLUG: (estado.tenants.find((t) => t.ID === Number(a.TENANT_ID)) || {}).SLUG || null }));
      return { rows: linhas };
    }

    throw new Error(`SQL não previsto no banco de teste: ${s}`);
  }

  return {
    execute,
    async commit() { estado.commits += 1; undo.length = 0; },
    async rollback() { estado.rollbacks += 1; while (undo.length) undo.pop()(); },
    async close() {},
    _ctx: ctx,
  };
}

let estado;
let registro; // toda query executada, na ordem

function instalarBanco() {
  estado = novoEstado();
  registro = [];
  db.getConnection = async () => novaConexao(estado, registro);
  db.comTenant = async (tenantId, fn) => {
    const conn = novaConexao(estado, registro);
    try {
      await conn.execute(`SELECT set_config('app.current_tenant_id', :tid, true)`, { tid: String(tenantId) });
      const r = await fn(conn);
      await conn.commit();
      return r;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      await conn.close();
    }
  };
  return estado;
}

// ---------------------------------------------------------------------------
// App + helpers HTTP
// ---------------------------------------------------------------------------
function startApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api', express.json());
  app.use('/api/operador', operadorRoutes);
  app.use('/api/auth', authRoutes);
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

function tokenOperador(operadorId = 1) {
  return jwt.sign({ jti: `op-${operadorId}-${Math.random()}`, escopo: 'operador', operadorId, email: 'op@olume.test' },
    SECRET_OPERADOR, { expiresIn: '1h' });
}

/** Provisiona um cliente pela API e devolve a resposta. */
function provisionar(port, tok, dados = {}, ip = '10.0.0.1') {
  return req(port, 'POST', '/api/operador/tenants', {
    tok, ip,
    body: { nome: 'Farmácia Sol', slug: 'sol', admin: { nome: 'Dona Ana', email: 'ana@sol.com.br' }, ...dados },
  });
}

let ctx;
let HASH_OPERADOR;
test.before(async () => {
  HASH_OPERADOR = await senhas.gerarHash(SENHA_OPERADOR);
  ctx = await startApp();
});
test.after(() => ctx && ctx.server.close());
test.beforeEach(() => {
  instalarBanco();
  estado.operadores.push({ ID: 1, EMAIL: 'op@olume.test', NOME: 'Operador', SENHA_HASH: HASH_OPERADOR, ATIVO: 'S' });
  rbac.invalidar(); // o perfil tem cache de 30s e os testes reusam ids
});

// ===========================================================================
// AC: provisionar cria tenant + usuário admin + convite, de forma ATÔMICA.
// ===========================================================================
test('provisionar cria tenant + usuário ADMIN + atendente vinculado + convite', async () => {
  const r = await provisionar(ctx.port, tokenOperador());
  assert.equal(r.status, 201, r.texto);

  assert.equal(estado.tenants.length, 1);
  const t = estado.tenants[0];
  assert.equal(t.SLUG, 'sol');
  assert.equal(t.STATUS, 'ativo');

  assert.equal(estado.usuarios.length, 1);
  const u = estado.usuarios[0];
  assert.equal(u.TENANT_ID, t.ID);
  assert.equal(u.EMAIL, 'ana@sol.com.br');
  assert.equal(u.SENHA_HASH, null, 'o usuário nasce SEM senha — quem define é ele, pelo convite');

  // Os dois lados do vínculo (decisão do PR #10): atendente.matricula = usuario.id.
  assert.equal(estado.atendentes.length, 1);
  const a = estado.atendentes[0];
  assert.equal(a.MATRICULA, u.ID, 'atendente.matricula tem que ser o usuario.id');
  assert.equal(a.PAPEL, 'ADMIN', 'sem ADMIN no provisionamento ninguém administra o tenant novo');
  assert.equal(a.TENANT_ID, t.ID);

  assert.equal(estado.tokensSenha.length, 1, 'o convite nasce junto');
  assert.equal(estado.tokensSenha[0].USUARIO_ID, u.ID);

  // O link volta na resposta (não há e-mail ainda) e aponta para a tela pública.
  assert.match(r.body.convite.link, /^https:\/\/painel\.olume\.test\/definir-senha\?empresa=sol&token=/);
  assert.ok(r.body.convite.expiraEm, 'convite sem expiração seria um link eterno');
});

test('provisionar roda numa transação só — uma conexão, um commit', async () => {
  const antes = estado.conexoes;
  await provisionar(ctx.port, tokenOperador());
  // 1 conexão do middleware (buscarAtivoPorId) + 1 do provisionamento.
  assert.equal(estado.conexoes - antes, 2);
  assert.equal(estado.rollbacks, 0);

  // Tenant, usuário, atendente e convite saíram TODOS da mesma transação, na
  // ordem esperada, com o contexto de tenant certo em cada etapa.
  const doProvisionamento = registro.filter((q) => /INSERT INTO (tenant|usuario|atendente|usuario_token_senha|operador_auditoria)/i.test(q.sql));
  assert.deepEqual(
    doProvisionamento.map((q) => q.sql.match(/INSERT INTO (\w+)/i)[1]),
    ['tenant', 'usuario', 'atendente', 'usuario_token_senha', 'operador_auditoria']
  );
  const t = estado.tenants[0];
  assert.equal(doProvisionamento[0].tenantCtx, null, 'o INSERT do tenant exige contexto NULO (policy tenant_operador)');
  assert.equal(doProvisionamento[1].tenantCtx, t.ID, 'o usuário nasce no contexto do tenant novo');
  assert.equal(doProvisionamento[3].tenantCtx, t.ID);
  assert.equal(doProvisionamento[4].tenantCtx, null, 'a trilha do operador não é tabela de tenant');
});

test('falha no meio do provisionamento faz ROLLBACK — nenhum tenant órfão', async () => {
  estado.falharEm = /INSERT INTO usuario \(/i;
  const r = await provisionar(ctx.port, tokenOperador());

  assert.equal(r.status, 500);
  assert.equal(estado.tenants.length, 0, 'o tenant ficou órfão: criado sem usuário administrador');
  assert.equal(estado.usuarios.length, 0);
  assert.equal(estado.atendentes.length, 0);
  assert.equal(estado.tokensSenha.length, 0);
  assert.equal(estado.rollbacks, 1);
  assert.equal(estado.commits, 1, 'só o commit da leitura do middleware — a ação não pode ter commitado');
  assert.equal(estado.auditoriaOperador.length, 0, 'auditoria de uma ação que não aconteceu');
});

test('falha ao gravar a AUDITORIA derruba o provisionamento inteiro', async () => {
  // A trilha não é "best-effort": ação sem registro não pode existir neste painel.
  estado.falharEm = /INSERT INTO operador_auditoria/i;
  const r = await provisionar(ctx.port, tokenOperador());
  assert.equal(r.status, 500);
  assert.equal(estado.tenants.length, 0);
  assert.equal(estado.usuarios.length, 0);
});

test('slug duplicado → 409, e o segundo tenant não é criado', async () => {
  assert.equal((await provisionar(ctx.port, tokenOperador())).status, 201);
  const r = await provisionar(ctx.port, tokenOperador(), { nome: 'Outra Empresa' });
  assert.equal(r.status, 409);
  assert.equal(estado.tenants.length, 1);
});

test('slug e e-mail inválidos são recusados antes de tocar o banco', async () => {
  for (const slug of ['Sol Maior', 'a', '-sol', 'sol-', 'sol/../etc', 'sol_maior', 'açaí']) {
    const r = await provisionar(ctx.port, tokenOperador(), { slug });
    assert.equal(r.status, 400, `slug ${JSON.stringify(slug)} deveria ser recusado (foi ${r.status})`);
  }
  const semEmail = await provisionar(ctx.port, tokenOperador(), { admin: { email: 'nao-e-email' } });
  assert.equal(semEmail.status, 400);
  assert.equal(estado.tenants.length, 0);
});

test('slug e e-mail são normalizados para minúsculas (como no login)', async () => {
  const r = await provisionar(ctx.port, tokenOperador(), { slug: 'SOL', admin: { email: 'Ana@Sol.com.BR' } });
  assert.equal(r.status, 201);
  assert.equal(estado.tenants[0].SLUG, 'sol', 'o login compara o slug byte a byte, em minúsculas');
  assert.equal(estado.usuarios[0].EMAIL, 'ana@sol.com.br', 'a 004 tem CHECK (email = lower(email))');
});

test('o token do convite NÃO aparece na auditoria nem no log — só na resposta', async () => {
  const linhas = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => linhas.push(a.map(String).join(' '));
  let r;
  try { r = await provisionar(ctx.port, tokenOperador()); } finally { Object.assign(console, orig); }

  const token = new URL(r.body.convite.link).searchParams.get('token');
  assert.ok(token && token.length > 20);
  const trilha = JSON.stringify(estado.auditoriaOperador);
  assert.equal(trilha.includes(token), false, 'o token em claro vazou para a auditoria');
  assert.equal(linhas.join('\n').includes(token), false, 'o token em claro vazou para o console');
  // No banco só existe o HASH do token, nunca ele.
  assert.equal(estado.tokensSenha[0].TOKEN_HASH.includes(token), false);
  assert.match(estado.tokensSenha[0].TOKEN_HASH, /^[0-9a-f]{64}$/, 'esperado SHA-256 hex');
});

// ===========================================================================
// Ciclo completo: convite → primeiro acesso → login como ADMIN.
// ===========================================================================
test('o convite do provisionamento é aceito pelo /api/auth/definir-senha e o admin entra como ADMIN', async () => {
  const prov = await provisionar(ctx.port, tokenOperador());
  const token = new URL(prov.body.convite.link).searchParams.get('token');

  const definiu = await req(ctx.port, 'POST', '/api/auth/definir-senha',
    { body: { empresa: 'sol', token, senha: SENHA_ADMIN }, ip: '10.7.0.1' });
  assert.equal(definiu.status, 200, definiu.texto);

  const login = await req(ctx.port, 'POST', '/api/auth/login',
    { body: { empresa: 'sol', email: 'ana@sol.com.br', senha: SENHA_ADMIN }, ip: '10.7.0.2' });
  assert.equal(login.status, 200, login.texto);
  assert.equal(login.body.papel, 'ADMIN', 'o primeiro usuário precisa entrar já administrando');
  const p = jwt.decode(login.body.token);
  assert.equal(p.tenantId, estado.tenants[0].ID);
  assert.equal(p.matricula, estado.usuarios[0].ID);
});

// ===========================================================================
// AC: suspender bloqueia o login E pausa os disparos de campanha.
// ===========================================================================
test('suspender bloqueia o login dos usuários do tenant; reativar libera de novo', async () => {
  const prov = await provisionar(ctx.port, tokenOperador());
  const token = new URL(prov.body.convite.link).searchParams.get('token');
  await req(ctx.port, 'POST', '/api/auth/definir-senha', { body: { empresa: 'sol', token, senha: SENHA_ADMIN }, ip: '10.8.0.1' });
  const tenantId = estado.tenants[0].ID;

  const antes = await req(ctx.port, 'POST', '/api/auth/login',
    { body: { empresa: 'sol', email: 'ana@sol.com.br', senha: SENHA_ADMIN }, ip: '10.8.0.2' });
  assert.equal(antes.status, 200);

  const susp = await req(ctx.port, 'POST', `/api/operador/tenants/${tenantId}/suspender`,
    { tok: tokenOperador(), body: { motivo: 'inadimplência' }, ip: '10.8.0.3' });
  assert.equal(susp.status, 200);
  assert.equal(estado.tenants[0].STATUS, 'suspenso');

  const depois = await req(ctx.port, 'POST', '/api/auth/login',
    { body: { empresa: 'sol', email: 'ana@sol.com.br', senha: SENHA_ADMIN }, ip: '10.8.0.4' });
  assert.equal(depois.status, 401, 'usuário de tenant suspenso não pode entrar');
  assert.equal(depois.body.token, undefined);

  const reat = await req(ctx.port, 'POST', `/api/operador/tenants/${tenantId}/reativar`,
    { tok: tokenOperador(), ip: '10.8.0.5' });
  assert.equal(reat.status, 200);
  const voltou = await req(ctx.port, 'POST', '/api/auth/login',
    { body: { empresa: 'sol', email: 'ana@sol.com.br', senha: SENHA_ADMIN }, ip: '10.8.0.6' });
  assert.equal(voltou.status, 200);
});

test('suspender pausa os disparos: o dispatcher não acorda campanha de tenant suspenso', async () => {
  await provisionar(ctx.port, tokenOperador());
  const tenantId = estado.tenants[0].ID;
  await req(ctx.port, 'POST', `/api/operador/tenants/${tenantId}/suspender`, { tok: tokenOperador(), ip: '10.9.0.1' });

  // O tick do dispatcher lê `campanha JOIN tenant ... t.STATUS = 'ativo'`; aqui o
  // JOIN é resolvido contra o MESMO estado que a rota de suspensão alterou.
  const acordados = [];
  const rawConn = {
    async execute(sql) {
      assert.match(sql, /t\.STATUS = 'ativo'/);
      const ativos = estado.tenants.filter((t) => t.STATUS === 'ativo').map((t) => t.ID);
      return { rows: [{ ID: 77, TENANT_ID: tenantId }].filter((c) => ativos.includes(c.TENANT_ID)) };
    },
    close: async () => {},
  };
  await dispatcher.tick({
    getConnection: async () => rawConn,
    comTenant: async (tid, fn) => { acordados.push(tid); return fn({ execute: async () => ({ rows: [] }) }); },
    sendTemplate: async () => ({ messages: [{ id: 'x' }] }),
    agora: () => new Date(),
  });
  assert.deepEqual(acordados, [], 'campanha de tenant suspenso foi disparada — mensagem paga indo para o cliente errado');
});

test('suspender de novo um tenant já suspenso → 409 (e nada muda)', async () => {
  await provisionar(ctx.port, tokenOperador());
  const id = estado.tenants[0].ID;
  await req(ctx.port, 'POST', `/api/operador/tenants/${id}/suspender`, { tok: tokenOperador() });
  const auditadas = estado.auditoriaOperador.length;
  const r = await req(ctx.port, 'POST', `/api/operador/tenants/${id}/suspender`, { tok: tokenOperador() });
  assert.equal(r.status, 409);
  assert.equal(estado.auditoriaOperador.length, auditadas, 'ação recusada não gera trilha de ação feita');
});

test('tenant inexistente → 404 em renomear, suspender e acesso de suporte', async () => {
  const tok = tokenOperador();
  assert.equal((await req(ctx.port, 'PATCH', '/api/operador/tenants/9999', { tok, body: { nome: 'X' } })).status, 404);
  assert.equal((await req(ctx.port, 'POST', '/api/operador/tenants/9999/suspender', { tok })).status, 404);
  assert.equal((await req(ctx.port, 'POST', '/api/operador/tenants/9999/acesso-suporte', { tok })).status, 404);
});

// ===========================================================================
// AC: TODA ação de operador gera registro de auditoria.
// ===========================================================================
test('toda ação de operador gera auditoria com quem, quando, em qual tenant e o quê', async () => {
  const tok = tokenOperador();
  await provisionar(ctx.port, tok, {}, '203.0.113.7');
  const id = estado.tenants[0].ID;

  const acoes = [
    ['PATCH', `/api/operador/tenants/${id}`, { nome: 'Farmácia Sol e Lua' }, 'tenant_renomeado'],
    ['POST', `/api/operador/tenants/${id}/acesso-suporte`, { motivo: 'chamado #12' }, 'acesso_suporte'],
    ['POST', `/api/operador/tenants/${id}/suspender`, { motivo: 'teste' }, 'tenant_suspenso'],
    ['POST', `/api/operador/tenants/${id}/reativar`, undefined, 'tenant_reativado'],
  ];
  for (const [metodo, rota, body, acao] of acoes) {
    const antes = estado.auditoriaOperador.length;
    const r = await req(ctx.port, metodo, rota, { tok, body, ip: '203.0.113.7' });
    assert.equal(r.status, 200, `${metodo} ${rota} → ${r.texto}`);
    assert.equal(estado.auditoriaOperador.length, antes + 1, `${acao} não gerou auditoria`);
    const linha = estado.auditoriaOperador[estado.auditoriaOperador.length - 1];
    assert.equal(linha.ACAO, acao);
    assert.equal(Number(linha.TENANT_ID), id, 'a trilha precisa dizer EM QUAL tenant');
    assert.equal(linha.OPERADOR_ID, 1, 'a trilha precisa dizer QUEM');
    assert.equal(linha.OPERADOR_EMAIL, 'op@olume.test');
    assert.equal(linha.IP, '203.0.113.7');
    assert.ok(linha.CRIADO_EM instanceof Date, 'a trilha precisa dizer QUANDO');
  }

  // login e logout também entram na trilha (sem tenant — não têm alvo).
  const login = await req(ctx.port, 'POST', '/api/operador/login',
    { body: { email: 'op@olume.test', senha: SENHA_OPERADOR }, ip: '203.0.113.8' });
  assert.equal(login.status, 200);
  assert.ok(estado.auditoriaOperador.some((a) => a.ACAO === 'login' && !a.TENANT_ID));

  assert.equal((await req(ctx.port, 'POST', '/api/operador/logout', { tok: login.body.token })).status, 200);
  assert.ok(estado.auditoriaOperador.some((a) => a.ACAO === 'logout'));

  // Login recusado também fica registrado — é o painel mais sensível do sistema.
  await req(ctx.port, 'POST', '/api/operador/login',
    { body: { email: 'op@olume.test', senha: 'errada-de-proposito' }, ip: '203.0.113.9' });
  assert.ok(estado.auditoriaOperador.some((a) => a.ACAO === 'login_recusado'));
});

test('o acesso de suporte fica registrado TAMBÉM na auditoria do cliente', async () => {
  const tok = tokenOperador();
  await provisionar(ctx.port, tok);
  const id = estado.tenants[0].ID;

  const r = await req(ctx.port, 'POST', `/api/operador/tenants/${id}/acesso-suporte`,
    { tok, body: { motivo: 'chamado #12' }, ip: '203.0.113.7' });
  assert.equal(r.status, 200, r.texto);

  // `auditoria` é a tabela que o painel do CLIENTE lê — é o que torna o acesso
  // visível para ele, como o ticket exige.
  const doCliente = estado.auditoriaTenant.filter((a) => a.ACAO === 'acesso_suporte');
  assert.equal(doCliente.length, 1);
  assert.equal(Number(doCliente[0].TENANT_ID), id);
  assert.equal(doCliente[0].CTX, id, 'a gravação na trilha do cliente precisa rodar no contexto dele');
  assert.match(String(doCliente[0].DETALHE), /op@olume\.test/);
  assert.match(String(doCliente[0].DETALHE), /chamado #12/);
});

test('GET /auditoria devolve a trilha, filtrável por tenant', async () => {
  const tok = tokenOperador();
  await provisionar(ctx.port, tok);
  await provisionar(ctx.port, tok, { nome: 'Padaria Lua', slug: 'lua', admin: { email: 'bia@lua.com.br' } });
  const [t1, t2] = estado.tenants;
  await req(ctx.port, 'POST', `/api/operador/tenants/${t2.ID}/suspender`, { tok });

  const todas = await req(ctx.port, 'GET', '/api/operador/auditoria', { tok });
  assert.equal(todas.status, 200);
  assert.equal(todas.body.length, 3);

  const doPrimeiro = await req(ctx.port, 'GET', `/api/operador/auditoria?tenantId=${t1.ID}`, { tok });
  assert.equal(doPrimeiro.body.length, 1);
  assert.equal(doPrimeiro.body[0].acao, 'tenant_provisionado');
  assert.equal(doPrimeiro.body[0].tenantSlug, 'sol');
});

// ===========================================================================
// Listagem com uso por tenant.
// ===========================================================================
test('GET /tenants lista os clientes com o uso do mês', async () => {
  const tok = tokenOperador();
  await provisionar(ctx.port, tok);
  await provisionar(ctx.port, tok, { nome: 'Padaria Lua', slug: 'lua', admin: { email: 'bia@lua.com.br' } });
  const [sol, lua] = estado.tenants;

  const agora = new Date();
  const mesPassado = new Date(agora.getFullYear(), agora.getMonth() - 1, 15);
  estado.conversas = [
    { TENANT_ID: sol.ID, CRIADO_EM: agora }, { TENANT_ID: sol.ID, CRIADO_EM: agora },
    { TENANT_ID: sol.ID, CRIADO_EM: mesPassado }, { TENANT_ID: lua.ID, CRIADO_EM: agora },
  ];
  estado.mensagens = [
    { TENANT_ID: sol.ID, DIRECAO: 'out', CRIADO_EM: agora },
    { TENANT_ID: sol.ID, DIRECAO: 'in', CRIADO_EM: agora },
  ];
  estado.numeros = [{ TENANT_ID: sol.ID, ATIVO: 'S' }, { TENANT_ID: sol.ID, ATIVO: 'N' }];

  const r = await req(ctx.port, 'GET', '/api/operador/tenants', { tok });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  const linhaSol = r.body.find((x) => x.slug === 'sol');
  assert.equal(linhaSol.conversasMes, 2, 'conversa do mês passado não conta no mês');
  assert.equal(linhaSol.mensagensMes, 1, 'só mensagem ENVIADA conta');
  assert.equal(linhaSol.atendentesAtivos, 1);
  assert.equal(linhaSol.numerosConectados, 1);
  assert.equal(linhaSol.usuariosAtivos, 1);
  assert.equal(r.body.find((x) => x.slug === 'lua').conversasMes, 1, 'uso de um cliente vazou para o outro');
});

test('renomear troca só o nome — o slug (credencial de login) é imutável', async () => {
  const tok = tokenOperador();
  await provisionar(ctx.port, tok);
  const id = estado.tenants[0].ID;
  const r = await req(ctx.port, 'PATCH', `/api/operador/tenants/${id}`,
    { tok, body: { nome: 'Farmácia Sol e Lua', slug: 'outro-slug' } });
  assert.equal(r.status, 200);
  assert.equal(estado.tenants[0].NOME, 'Farmácia Sol e Lua');
  assert.equal(estado.tenants[0].SLUG, 'sol', 'trocar o slug derrubaria o login de todo mundo do tenant');
});
