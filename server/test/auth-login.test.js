// Testes do login próprio (FIL-67) — POST /api/auth/login.
//
// Cobrem os critérios de aceite do ticket:
//  • senha errada, usuário inativo e usuário de OUTRO tenant devolvem 401 —
//    com resposta IDÊNTICA, sem dizer qual dos três foi;
//  • o JWT emitido carrega o tenant_id;
//  • a senha nunca aparece na resposta (nem na de erro de validação) nem em
//    nada escrito no console;
//  • o rate-limit do login continua de pé.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const rbac = require('../auth/rbac');
const senhas = require('../auth/senha');
const authRoutes = require('../auth/routes');

const SENHA_ANA = 'senha-da-ana-2026';
const SENHA_BOB = 'senha-do-bob-2026';

// ---------------------------------------------------------------------------
// "Banco" em memória: dois tenants, com um usuário homônimo de propósito.
// ---------------------------------------------------------------------------
const TENANTS = [
  { ID: 1, SLUG: 'acme', STATUS: 'ativo' },
  { ID: 2, SLUG: 'globex', STATUS: 'ativo' },
  { ID: 3, SLUG: 'falida', STATUS: 'encerrado' },
];
let USUARIOS = {};

/** Instala os mocks de banco. `capturas` recebe { tenantId, sql, binds }. */
function instalarBanco(capturas = []) {
  db.getConnection = async () => ({
    async execute(sql, binds) {
      capturas.push({ tenantId: null, sql, binds });
      if (/FROM tenant/i.test(sql)) {
        // Só tenant ATIVO é resolvido (o SQL real filtra status = 'ativo').
        const t = TENANTS.find((x) => x.SLUG === binds.slug && x.STATUS === 'ativo');
        return { rows: t ? [{ ID: t.ID }] : [] };
      }
      return { rows: [] };
    },
    async close() {},
  });

  db.comTenant = async (tenantId, fn) => fn({
    async execute(sql, binds) {
      capturas.push({ tenantId, sql, binds });
      // Toda query de dado precisa carregar o tenant do contexto — se um dia
      // alguém tirar o filtro, o teste denuncia antes da RLS precisar salvar.
      assert.equal(binds.tenantId, tenantId, `query sem o tenant do contexto: ${sql}`);
      if (/FROM usuario\b/i.test(sql)) {
        const linhas = USUARIOS[tenantId] || [];
        const u = linhas.find((x) => x.EMAIL === binds.email);
        return { rows: u ? [u] : [] };
      }
      return { rows: [] };
    },
  });
  return capturas;
}

function startApp() {
  const app = express();
  // É o que faz req.ip vir do X-Forwarded-For, e é assim que cada teste
  // consegue seu próprio balde de rate-limit (o valor exato — quantos hops —
  // não importa aqui; ver test/trust-proxy.test.js para o valor real do app.js).
  app.set('trust proxy', 1);
  app.use('/api', express.json());
  app.use('/api/auth', authRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function req(port, method, path, body, ip = '10.0.0.1') {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      { method, hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip,
                   ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let o = '';
        res.on('data', (c) => (o += c));
        res.on('end', () => {
          let body = {};
          try { body = JSON.parse(o || '{}'); } catch { /* resposta não-JSON: só `texto` importa */ }
          resolve({ status: res.statusCode, texto: o, body });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** Roda `fn` capturando tudo que for escrito no console. */
async function capturandoConsole(fn) {
  const linhas = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => linhas.push(args.map((a) => String(a)).join(' '));
  }
  try {
    return { resultado: await fn(), log: linhas.join('\n') };
  } finally {
    Object.assign(console, orig);
  }
}

let ctx;
test.before(async () => {
  const hashAna = await senhas.gerarHash(SENHA_ANA);
  const hashBob = await senhas.gerarHash(SENHA_BOB);
  USUARIOS = {
    1: [
      { ID: 10, NOME: 'Ana', EMAIL: 'ana@acme.com', SENHA_HASH: hashAna, ATIVO: 'S' },
      { ID: 11, NOME: 'Inativo', EMAIL: 'inativo@acme.com', SENHA_HASH: hashAna, ATIVO: 'N' },
      { ID: 12, NOME: 'Recém-criado', EMAIL: 'novo@acme.com', SENHA_HASH: null, ATIVO: 'S' },
    ],
    2: [{ ID: 20, NOME: 'Bob', EMAIL: 'bob@globex.com', SENHA_HASH: hashBob, ATIVO: 'S' }],
  };
  instalarBanco();
  // O perfil RBAC tem testes próprios; aqui ele só não pode derrubar o login.
  rbac.carregarPerfil = async () => ({ atendenteId: 99, papel: 'ADMIN', ativo: true, deptoIds: [4], numeroIds: [], pausado: false, podeAtivo: true });
  ctx = await startApp();
});
test.after(() => ctx && ctx.server.close());

// ---------------------------------------------------------------------------
test('login válido devolve token com tenant_id no payload', async () => {
  const r = await req(ctx.port, 'POST', '/api/auth/login',
    { empresa: 'acme', email: 'ana@acme.com', senha: SENHA_ANA }, '10.1.0.1');
  assert.equal(r.status, 200);
  const p = jwt.decode(r.body.token);
  assert.equal(p.tenantId, 1);
  assert.equal(p.usuarioId, 10);
  assert.equal(p.matricula, 10, 'matricula = usuario.id (chave operacional do RBAC)');
  assert.ok(p.jti, 'sem jti o logout não teria o que colocar na blacklist');
  assert.equal(r.body.papel, 'ADMIN');
});

test('e-mail e empresa não diferenciam maiúsculas; a SENHA diferencia', async () => {
  const ok = await req(ctx.port, 'POST', '/api/auth/login',
    { empresa: 'ACME', email: '  Ana@Acme.COM ', senha: SENHA_ANA }, '10.1.0.2');
  assert.equal(ok.status, 200);

  const caixaTrocada = await req(ctx.port, 'POST', '/api/auth/login',
    { empresa: 'acme', email: 'ana@acme.com', senha: SENHA_ANA.toUpperCase() }, '10.1.0.3');
  assert.equal(caixaTrocada.status, 401, 'o login antigo comparava com UPPER() dos dois lados');
});

// ---------------------------------------------------------------------------
// AC: senha errada, usuário inativo e usuário de outro tenant → 401, sem
// vazar qual dos três foi.
// ---------------------------------------------------------------------------
test('401 uniforme: senha errada, inativo, outro tenant, inexistente e sem senha definida', async () => {
  const casos = {
    'senha errada':        { empresa: 'acme',   email: 'ana@acme.com',     senha: 'senha-errada-1' },
    'usuário inativo':     { empresa: 'acme',   email: 'inativo@acme.com', senha: SENHA_ANA },
    'usuário de outro tenant': { empresa: 'acme', email: 'bob@globex.com', senha: SENHA_BOB },
    'e-mail inexistente':  { empresa: 'acme',   email: 'ninguem@acme.com', senha: SENHA_ANA },
    'senha ainda não definida': { empresa: 'acme', email: 'novo@acme.com', senha: SENHA_ANA },
    'empresa inexistente': { empresa: 'nao-existe', email: 'ana@acme.com', senha: SENHA_ANA },
    'empresa encerrada':   { empresa: 'falida', email: 'ana@acme.com',     senha: SENHA_ANA },
  };

  const respostas = [];
  let i = 0;
  for (const [nome, corpo] of Object.entries(casos)) {
    const r = await req(ctx.port, 'POST', '/api/auth/login', corpo, `10.2.0.${++i}`);
    assert.equal(r.status, 401, `${nome} deveria ser 401`);
    respostas.push([nome, r.texto]);
  }
  const [, primeira] = respostas[0];
  for (const [nome, texto] of respostas) {
    assert.equal(texto, primeira, `a resposta de "${nome}" difere das demais — vaza qual foi o motivo`);
  }
});

test('o usuário de globex entra em globex — o 401 acima era isolamento, não bug', async () => {
  const r = await req(ctx.port, 'POST', '/api/auth/login',
    { empresa: 'globex', email: 'bob@globex.com', senha: SENHA_BOB }, '10.3.0.1');
  assert.equal(r.status, 200);
  assert.equal(jwt.decode(r.body.token).tenantId, 2);
});

test('a consulta do usuário roda no contexto do tenant do slug — nunca no do vizinho', async () => {
  const capturas = [];
  instalarBanco(capturas);
  await req(ctx.port, 'POST', '/api/auth/login',
    { empresa: 'globex', email: 'bob@globex.com', senha: SENHA_BOB }, '10.3.0.2');
  const doUsuario = capturas.filter((c) => /FROM usuario\b/i.test(c.sql));
  assert.equal(doUsuario.length, 1);
  assert.equal(doUsuario[0].tenantId, 2);
  instalarBanco(); // restaura o mock sem capturas para os testes seguintes
});

// ---------------------------------------------------------------------------
// AC: a senha nunca aparece em log nem na resposta.
// ---------------------------------------------------------------------------
test('a senha não aparece na resposta nem no console — sucesso, 401 e 400', async () => {
  const SEGREDO = 'ABRACADABRA-2026-nao-pode-vazar';

  const { resultado, log } = await capturandoConsole(async () => [
    await req(ctx.port, 'POST', '/api/auth/login',
      { empresa: 'acme', email: 'ana@acme.com', senha: SENHA_ANA }, '10.4.0.1'),
    await req(ctx.port, 'POST', '/api/auth/login',
      { empresa: 'acme', email: 'ana@acme.com', senha: SEGREDO }, '10.4.0.2'),
    // 400 de validação: `validationResult().array()` inclui o VALOR do campo
    // por padrão — é exatamente esta a regressão que este caso guarda.
    await req(ctx.port, 'POST', '/api/auth/login',
      { empresa: 'acme', email: 'ana@acme.com', senha: SEGREDO.repeat(20) }, '10.4.0.3'),
  ]);

  assert.equal(resultado[0].status, 200);
  assert.equal(resultado[1].status, 401);
  assert.equal(resultado[2].status, 400);
  for (const r of resultado) {
    assert.equal(r.texto.includes(SEGREDO), false, `senha vazou na resposta: ${r.texto}`);
    assert.equal(r.texto.includes(SENHA_ANA), false, `senha vazou na resposta: ${r.texto}`);
  }
  assert.equal(log.includes(SEGREDO), false, `senha vazou no console: ${log}`);
  assert.equal(log.includes(SENHA_ANA), false, `senha vazou no console: ${log}`);
});

test('o token emitido não carrega senha nem hash', async () => {
  const r = await req(ctx.port, 'POST', '/api/auth/login',
    { empresa: 'acme', email: 'ana@acme.com', senha: SENHA_ANA }, '10.5.0.1');
  const p = jwt.decode(r.body.token);
  assert.equal(JSON.stringify(p).includes(SENHA_ANA), false);
  assert.equal(JSON.stringify(p).includes('argon2'), false);
  assert.equal('senha' in p, false);
  assert.equal('senha_hash' in p, false);
  assert.equal(r.texto.includes('argon2'), false, 'o hash não pode sair na resposta');
});

// ---------------------------------------------------------------------------
test('rate-limit do login continua de pé (11ª tentativa do mesmo IP → 429)', async () => {
  const IP = '10.9.9.9';
  let ultima;
  for (let i = 0; i < 11; i++) {
    ultima = await req(ctx.port, 'POST', '/api/auth/login',
      { empresa: 'acme', email: 'ana@acme.com', senha: 'errada-de-proposito' }, IP);
  }
  assert.equal(ultima.status, 429);
  assert.ok(ultima.body.error, 'o 429 precisa vir em JSON com `error` — o front lê esse campo');
});

test('campos ausentes ou de tipo errado → 400 sem tocar o banco', async () => {
  const r1 = await req(ctx.port, 'POST', '/api/auth/login', { email: 'ana@acme.com', senha: SENHA_ANA }, '10.6.0.1');
  assert.equal(r1.status, 400);
  const r2 = await req(ctx.port, 'POST', '/api/auth/login', { empresa: 'acme', email: 'ana@acme.com', senha: 12345 }, '10.6.0.2');
  assert.equal(r2.status, 400);
});
