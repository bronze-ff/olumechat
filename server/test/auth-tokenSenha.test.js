// Testes do token de definição de senha no primeiro acesso (FIL-67).
//
// Prova o que o ticket exige do token: USO ÚNICO, EXPIRAÇÃO e HASH EM BANCO
// (o token em claro nunca é persistido). Mais o isolamento por tenant e o
// fato de a senha nunca aparecer em claro em nenhum bind.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const db = require('../db/pool');
const senhas = require('../auth/senha');
const tokenSenha = require('../auth/tokenSenha');

// ---------------------------------------------------------------------------
// "Banco" em memória com as duas tabelas da migração 004, por tenant.
// ---------------------------------------------------------------------------
let banco;
let binds; // todos os binds que passaram pelo "banco", para inspeção

function zerar() {
  banco = {
    1: { usuarios: [{ ID: 10, NOME: 'Ana', EMAIL: 'ana@acme.com', SENHA_HASH: null, ATIVO: 'S' },
                    { ID: 11, NOME: 'Ex', EMAIL: 'ex@acme.com', SENHA_HASH: null, ATIVO: 'N' }],
         tokens: [] },
    2: { usuarios: [{ ID: 20, NOME: 'Bob', EMAIL: 'bob@globex.com', SENHA_HASH: null, ATIVO: 'S' }],
         tokens: [] },
  };
  binds = [];
  let seq = 0;

  db.comTenant = async (tenantId, fn) => {
    const t = banco[tenantId] || (banco[tenantId] = { usuarios: [], tokens: [] });
    const agora = () => new Date();
    return fn({
      async execute(sql, b = {}) {
        binds.push({ tenantId, sql, binds: b });
        assert.equal(b.tenantId, tenantId, `query sem o tenant do contexto: ${sql}`);

        if (/^\s*UPDATE usuario_token_senha SET usado_em[\s\S]*usuario_id = :uid/i.test(sql)) {
          // invalidação em massa dos tokens em aberto do usuário
          const alvos = t.tokens.filter((x) => x.usuarioId === b.uid && !x.usadoEm);
          alvos.forEach((x) => { x.usadoEm = agora(); });
          return { rowsAffected: alvos.length };
        }
        if (/^\s*INSERT INTO usuario_token_senha/i.test(sql)) {
          t.tokens.push({ id: ++seq, usuarioId: b.uid, tokenHash: b.hash, expiraEm: b.exp, usadoEm: null });
          return { rowsAffected: 1 };
        }
        if (/^\s*UPDATE usuario_token_senha SET usado_em[\s\S]*token_hash = :hash/i.test(sql)) {
          const alvo = t.tokens.find((x) => x.tokenHash === b.hash && !x.usadoEm && x.expiraEm > agora());
          if (!alvo) return { rowsAffected: 0, outBinds: { uid: [undefined] } };
          alvo.usadoEm = agora();
          return { rowsAffected: 1, outBinds: { uid: [alvo.usuarioId] } };
        }
        if (/^\s*SELECT[\s\S]*FROM usuario_token_senha/i.test(sql)) {
          const alvo = t.tokens.find((x) => x.tokenHash === b.hash && !x.usadoEm && x.expiraEm > agora());
          const u = alvo && t.usuarios.find((x) => x.ID === alvo.usuarioId && x.ATIVO === 'S');
          return { rows: u ? [{ NOME: u.NOME, EMAIL: u.EMAIL }] : [] };
        }
        if (/^\s*UPDATE usuario\b/i.test(sql)) {
          const u = t.usuarios.find((x) => x.ID === b.uid && x.ATIVO === 'S');
          if (!u) return { rowsAffected: 0 };
          u.SENHA_HASH = b.hash;
          return { rowsAffected: 1 };
        }
        return { rows: [], rowsAffected: 0 };
      },
    });
  };
}

const SENHA_BOA = 'uma-senha-bem-comprida';

test.beforeEach(() => zerar());

// ---------------------------------------------------------------------------
test('o token em claro NUNCA vai para o banco — só o SHA-256 dele', async () => {
  const { token } = await tokenSenha.gerarToken(1, 10);

  const gravado = banco[1].tokens[0].tokenHash;
  assert.equal(gravado, crypto.createHash('sha256').update(token, 'utf8').digest('hex'));
  assert.equal(gravado.length, 64);
  assert.notEqual(gravado, token);

  const tudo = JSON.stringify(binds);
  assert.equal(tudo.includes(token), false, 'o token em claro apareceu num bind');
});

test('token de 256 bits, url-safe e diferente a cada chamada', async () => {
  const a = await tokenSenha.gerarToken(1, 10);
  const b = await tokenSenha.gerarToken(1, 10);
  assert.notEqual(a.token, b.token);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(a.token), `token fora do formato base64url: ${a.token}`);
  assert.ok(a.expiraEm instanceof Date && a.expiraEm > new Date());
});

test('emitir um token novo aposenta o anterior do mesmo usuário', async () => {
  const antigo = await tokenSenha.gerarToken(1, 10);
  await tokenSenha.gerarToken(1, 10);
  assert.equal((await tokenSenha.verificarToken(1, antigo.token)).valido, false);
});

// ---------------------------------------------------------------------------
test('USO ÚNICO: o mesmo token não define senha duas vezes', async () => {
  const { token } = await tokenSenha.gerarToken(1, 10);

  const primeira = await tokenSenha.definirSenha(1, token, SENHA_BOA);
  assert.deepEqual(primeira, { ok: true, usuarioId: 10 });

  const segunda = await tokenSenha.definirSenha(1, token, 'outra-senha-comprida');
  assert.equal(segunda.ok, false);
  assert.equal(segunda.motivo, 'token_invalido');

  // e a senha continua sendo a da PRIMEIRA definição
  assert.ok(await senhas.conferir(banco[1].usuarios[0].SENHA_HASH, SENHA_BOA));
});

test('EXPIRAÇÃO: token vencido não define senha nem passa na verificação', async () => {
  const token = 'token-vencido-de-teste-com-tamanho';
  banco[1].tokens.push({
    id: 99, usuarioId: 10, tokenHash: tokenSenha.hashDoToken(token),
    expiraEm: new Date(Date.now() - 1000), usadoEm: null,
  });
  assert.equal((await tokenSenha.verificarToken(1, token)).valido, false);
  const r = await tokenSenha.definirSenha(1, token, SENHA_BOA);
  assert.equal(r.ok, false);
  assert.equal(banco[1].usuarios[0].SENHA_HASH, null, 'a senha foi gravada com token vencido');
});

test('ISOLAMENTO: token emitido no tenant 1 não vale no tenant 2', async () => {
  const { token } = await tokenSenha.gerarToken(1, 10);
  const r = await tokenSenha.definirSenha(2, token, SENHA_BOA);
  assert.equal(r.ok, false);
  assert.equal(banco[1].usuarios[0].SENHA_HASH, null);
});

test('usuário desativado: token queima e a senha não é gravada', async () => {
  const { token } = await tokenSenha.gerarToken(1, 11); // usuário ATIVO = 'N'
  const r = await tokenSenha.definirSenha(1, token, SENHA_BOA);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'usuario_inativo');
  assert.equal(banco[1].usuarios[1].SENHA_HASH, null);
  assert.ok(banco[1].tokens[0].usadoEm, 'link de conta desativada não pode sobreviver');
});

// ---------------------------------------------------------------------------
test('senha fraca é recusada ANTES de tocar o banco', async () => {
  const { token } = await tokenSenha.gerarToken(1, 10);
  const antes = binds.length;
  const r = await tokenSenha.definirSenha(1, token, 'curta');
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'senha_fraca');
  assert.equal(binds.length, antes, 'rodou query com senha inválida');
  assert.equal((await tokenSenha.verificarToken(1, token)).valido, true, 'o token não podia ter sido consumido');
});

test('a senha em claro nunca aparece num bind — só o hash argon2id', async () => {
  const { token } = await tokenSenha.gerarToken(1, 10);
  await tokenSenha.definirSenha(1, token, SENHA_BOA);

  const tudo = JSON.stringify(binds);
  assert.equal(tudo.includes(SENHA_BOA), false, 'a senha em claro foi para o banco');

  const hash = banco[1].usuarios[0].SENHA_HASH;
  assert.ok(hash.startsWith('$argon2id$'), `hash não é argon2id: ${hash}`);
  assert.ok(await senhas.conferir(hash, SENHA_BOA));
  assert.equal(await senhas.conferir(hash, SENHA_BOA.toUpperCase()), false, 'senha não pode ser case-insensitive');
});

test('verificarToken devolve nome/e-mail do dono e não consome o token', async () => {
  const { token } = await tokenSenha.gerarToken(1, 10);
  const v = await tokenSenha.verificarToken(1, token);
  assert.deepEqual(v, { valido: true, nome: 'Ana', email: 'ana@acme.com' });
  assert.equal((await tokenSenha.definirSenha(1, token, SENHA_BOA)).ok, true);
});

test('token ausente/vazio é recusado sem tocar o banco', async () => {
  const antes = binds.length;
  assert.equal((await tokenSenha.verificarToken(1, '')).valido, false);
  assert.equal((await tokenSenha.definirSenha(1, '', SENHA_BOA)).motivo, 'token_ausente');
  assert.equal(binds.length, antes);
});
