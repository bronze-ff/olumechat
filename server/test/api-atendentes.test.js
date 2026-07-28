'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
// O admin do TENANT cria/gerencia atendentes no próprio painel (não é mais só
// "aparece no primeiro login"): POST cria usuário+atendente e devolve um link
// de definir-senha; POST /:id/resetar-senha emite um novo; PUT com ativo='N'
// bloqueia o LOGIN de verdade (usuario.ativo), não só a operação.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');
const tokenSenha = require('../auth/tokenSenha');

function servidor(papel = 'ADMIN', tenantId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { matricula: 10 }; req.perfil = { atendenteId: 1, papel }; req.tenantId = tenantId; next(); });
  app.use('/api/atendentes', require('../api/atendentes'));
  return app;
}
function req(app, metodo, path, corpo) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = srv.address().port;
      const r = http.request({ port, path, method: metodo, headers: { 'content-type': 'application/json' } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
          srv.close();
          let body = null; try { body = d ? JSON.parse(d) : null; } catch { /* resposta não-JSON (404 default) */ }
          resolve({ status: res.statusCode, body });
        });
      });
      if (corpo) r.write(JSON.stringify(corpo));
      r.end();
    });
  });
}

test('POST cria usuário + atendente e devolve o link de definir senha (sem senha em claro em lugar nenhum)', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, binds) {
    cap.push({ sql, binds });
    if (/INSERT INTO usuario /i.test(sql)) return { rows: [{ ID: 42 }] };
    if (/INSERT INTO atendente /i.test(sql)) return { rows: [{ ID: 7 }] };
    if (/SELECT slug FROM tenant/i.test(sql)) return { rows: [{ SLUG: 'multicanal' }] };
    return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  tokenSenha.gerarToken = async () => ({ token: 'tok-abc', expiraEm: new Date('2026-01-01T00:00:00Z') });

  const res = await req(servidor(), 'POST', '/api/atendentes', { email: 'Nova@Empresa.com.br', nome: 'Nova Pessoa', papel: 'ATENDENTE' });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 7);
  assert.match(res.body.convite.link, /empresa=multicanal/);
  assert.match(res.body.convite.link, /token=tok-abc/);
  const insUsuario = cap.find((c) => /INSERT INTO usuario /i.test(c.sql));
  assert.equal(insUsuario.binds.email, 'nova@empresa.com.br', 'e-mail normalizado pra minúsculas');
  assert.ok(cap.some((c) => /INSERT INTO auditoria/i.test(c.sql)), 'audita a criação');
});

test('POST rejeita e-mail inválido', async () => {
  db.getConnection = async () => ({ async execute() { return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'POST', '/api/atendentes', { email: 'não-é-email', papel: 'ATENDENTE' });
  assert.equal(res.status, 400);
});

test('POST rejeita papel inválido', async () => {
  db.getConnection = async () => ({ async execute() { return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'POST', '/api/atendentes', { email: 'a@b.com', papel: 'DONO' });
  assert.equal(res.status, 400);
});

test('POST com e-mail já usado no tenant → 409', async () => {
  db.getConnection = async () => ({ async execute(sql) {
    if (/INSERT INTO usuario /i.test(sql)) { const e = new Error('duplicate'); e.code = '23505'; throw e; }
    return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'POST', '/api/atendentes', { email: 'ja@existe.com', papel: 'ATENDENTE' });
  assert.equal(res.status, 409);
});

test('POST com papel não-ADMIN retorna 403', async () => {
  db.getConnection = async () => ({ async execute() { return { rows: [] }; }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor('ATENDENTE'), 'POST', '/api/atendentes', { email: 'a@b.com', papel: 'ATENDENTE' });
  assert.equal(res.status, 403);
});

test('resetar-senha emite um novo link pro usuário daquele atendente', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, binds) {
    cap.push({ sql, binds });
    if (/SELECT matricula FROM atendente/i.test(sql)) return { rows: [{ MATRICULA: 42 }] };
    if (/SELECT slug FROM tenant/i.test(sql)) return { rows: [{ SLUG: 'multicanal' }] };
    return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  tokenSenha.gerarToken = async (tenantId, usuarioId) => { assert.equal(usuarioId, 42); return { token: 'tok-novo', expiraEm: new Date('2026-02-01T00:00:00Z') }; };

  const res = await req(servidor(), 'POST', '/api/atendentes/7/resetar-senha');
  assert.equal(res.status, 200);
  assert.match(res.body.convite.link, /token=tok-novo/);
  assert.ok(cap.some((c) => /INSERT INTO auditoria/i.test(c.sql) && /senha_resetada/.test(JSON.stringify(c.binds) + c.sql)), 'audita o reset');
});

test('resetar-senha de atendente inexistente → 404', async () => {
  db.getConnection = async () => ({ async execute(sql) {
    if (/SELECT matricula FROM atendente/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'POST', '/api/atendentes/999/resetar-senha');
  assert.equal(res.status, 404);
});

test('PUT ativo=N também desativa o usuário — bloqueia o LOGIN, não só a operação', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, binds) {
    cap.push({ sql, binds });
    if (/SELECT matricula, papel, ativo FROM atendente/i.test(sql)) return { rows: [{ MATRICULA: 42, PAPEL: 'ATENDENTE', ATIVO: 'S' }] };
    return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'PUT', '/api/atendentes/7', { ativo: 'N' });
  assert.equal(res.status, 200);
  const updUsuario = cap.find((c) => /UPDATE usuario SET ativo/i.test(c.sql));
  assert.ok(updUsuario, 'atualiza usuario.ativo também');
  assert.equal(updUsuario.binds.a, 'N');
  assert.equal(updUsuario.binds.uid, 42, 'usa a matricula certa (matricula = usuario.id)');
});

test('PUT sem mudar ativo NÃO mexe em usuario.ativo', async () => {
  const cap = [];
  db.getConnection = async () => ({ async execute(sql, binds) {
    cap.push({ sql, binds });
    if (/SELECT matricula, papel, ativo FROM atendente/i.test(sql)) return { rows: [{ MATRICULA: 42, PAPEL: 'ATENDENTE', ATIVO: 'S' }] };
    return { rows: [] };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} });
  const res = await req(servidor(), 'PUT', '/api/atendentes/7', { papel: 'SUPERVISOR' });
  assert.equal(res.status, 200);
  assert.ok(!cap.some((c) => /UPDATE usuario SET ativo/i.test(c.sql)));
});
