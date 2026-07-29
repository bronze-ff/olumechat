// Testes de encerramento das conexões SSE abertas (server/api/stream.js) —
// FIL-93 (P0.7): SIGTERM precisa fechar as conexões de longa duração, senão
// server.close() (server/app.js) nunca chama seu callback (ele só resolve
// quando TODAS as conexões existentes terminam) e o processo trava até o
// prazo máximo de encerramento.
//
// Sessão de SUPORTE (ticket com `suporte: true`) não passa por
// auth/rbac.js::carregarPerfil (não tem matrícula) nem por realtime/presence
// — dá pra abrir o stream de ponta a ponta sem mockar banco.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const streamRouter = require('../api/stream');
const { criarTicket } = require('../auth/sseTicket');
const db = require('../db/pool');

function startApp() {
  const app = express();
  app.use('/api/stream', streamRouter);
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function abrirStream(port, ticket) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', hostname: '127.0.0.1', port, path: `/api/stream?ticket=${ticket}` });
    req.on('response', (res) => {
      let recebeuReady = false;
      let fechou = false;
      res.on('data', (chunk) => {
        if (chunk.toString().includes('event: ready')) recebeuReady = true;
      });
      res.on('end', () => { fechou = true; });
      // dá um tempo para o "event: ready" chegar antes de resolver
      setTimeout(() => resolve({
        req, res,
        recebeuReady: () => recebeuReady,
        fechou: () => fechou,
      }), 100);
    });
    req.on('error', reject);
    req.end();
  });
}

test('encerrarTodas() fecha as conexões SSE abertas (permite server.close() completar no shutdown)', { timeout: 5000 }, async () => {
  const { server, port } = await startApp();
  try {
    const ticket = criarTicket({ tenantId: 1, suporte: true });
    const conexao = await abrirStream(port, ticket);
    assert.ok(conexao.recebeuReady(), 'a conexão deveria ter recebido o evento "ready"');
    assert.equal(conexao.fechou(), false, 'a conexão deveria continuar aberta antes do shutdown');

    streamRouter.encerrarTodas();

    await new Promise((resolve) => conexao.res.on('end', resolve));
    assert.equal(conexao.fechou(), true, 'encerrarTodas() deveria ter fechado a conexão SSE');
  } finally {
    server.close();
  }
});

test('encerrarTodas() sem nenhuma conexão aberta não lança erro', () => {
  assert.doesNotThrow(() => streamRouter.encerrarTodas());
});

function requisicaoJson(port, ticket) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', hostname: '127.0.0.1', port, path: `/api/stream?ticket=${ticket}` });
    req.on('response', (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, corpo }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Achado P3 da review cruzada (Codex, PR #39): entre o ticket ser consumido e
// a conexão entrar em `conexoesAbertas` (linha ~109), o handler faz um
// `await carregarPerfil(...)` — uma consulta real ao banco. Se o SIGTERM (e
// portanto encerrarTodas()) chegar NESSA janela, a conexão ainda não está no
// Set quando encerrarTodas() varre — ela é aberta DEPOIS do drain ter
// começado, escapa do encerramento e prende server.close() até o prazo
// máximo de 10s estourar (saída suja, exit 1) em vez de sair limpo.
test('conexão cujo setup termina DEPOIS do início do drain é rejeitada (503), não escapa do shutdown', { timeout: 5000 }, async () => {
  let liberarCarregarPerfil;
  const perfilTravado = new Promise((resolve) => { liberarCarregarPerfil = resolve; });
  const comTenantOriginal = db.comTenant;
  db.comTenant = async (tenantId, fn) => {
    await perfilTravado; // simula a consulta de carregarPerfil ainda em voo
    return fn({
      async execute(sql) {
        if (/FROM atendente WHERE/i.test(sql)) {
          return { rows: [{ ID: 321, PAPEL: 'ATENDENTE', ATIVO: 'S', STATUS_PRESENCA: null, PODE_ATIVO: 'N' }] };
        }
        return { rows: [] };
      },
    });
  };

  const { server, port } = await startApp();
  try {
    const ticket = criarTicket({ tenantId: 777, matricula: 8888, nome: 'Corrida' }); // par tenant/matrícula inédito — sem cache
    const respostaPromise = requisicaoJson(port, ticket);

    // dá espaço pro handler entrar no `await db.comTenant(...)` antes de continuar.
    await new Promise((resolve) => setImmediate(resolve));

    streamRouter.encerrarTodas(); // "SIGTERM chegou" — dispara o drain enquanto o setup está em voo
    liberarCarregarPerfil();      // só ENTÃO o carregarPerfil resolve e o handler tenta prosseguir

    const resposta = await respostaPromise;
    assert.equal(resposta.status, 503, 'conexão que só terminou o setup depois do drain começar deveria ser rejeitada, não aberta');
  } finally {
    db.comTenant = comTenantOriginal;
    server.close();
  }
});
