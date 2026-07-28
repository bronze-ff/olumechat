// Testes do rate limit por USUÁRIO (server/utils/rateLimitPorUsuario.js).
// keyGenerator precisa ser o par tenantId+matrícula (ou tenantId+operadorId
// pra sessão de suporte), não o IP: dois usuários no mesmo IP não podem
// dividir o mesmo teto, e um usuário/operador trocando de IP não pode
// escapar dele. Isso é o que este arquivo prova isolado da rota de negócio
// (mais rápido e não depende do teto real do B2/B3).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { limiterPorUsuario } = require('../utils/rateLimitPorUsuario');

function app(max) {
  const a = express();
  a.set('trust proxy', 1); // pra x-forwarded-for valer nos testes de troca de IP
  a.use((req, _res, next) => {
    const m = req.headers['x-matricula'];
    const op = req.headers['x-operador'];
    req.tenantId = 1;
    // Os dois campos podem coexistir no mesmo req.user (não acontece de
    // verdade — token de tenant não tem operadorId, token de suporte não tem
    // matrícula — mas aqui é assim de propósito, pra exercitar a prioridade
    // real dentro de chavePorUsuario, não só o roteamento deste app de teste).
    if (m || op) {
      req.user = { tenantId: 1 };
      if (m) req.user.matricula = Number(m);
      if (op) req.user.operadorId = Number(op);
    }
    next();
  });
  a.get('/rota', limiterPorUsuario({ windowMs: 60_000, max, mensagem: 'devagar' }), (req, res) => res.json({ ok: true }));
  return a;
}

/** @param {number|{matricula?:number, operador?:number, ip?:string}} opts */
function get(port, opts) {
  const o = typeof opts === 'number' ? { matricula: opts } : (opts || {});
  return new Promise((resolve, reject) => {
    const headers = {};
    if (o.matricula != null) headers['x-matricula'] = o.matricula;
    if (o.operador != null) headers['x-operador'] = o.operador;
    if (o.ip) headers['x-forwarded-for'] = o.ip;
    const r = http.request(
      { method: 'GET', hostname: '127.0.0.1', port, path: '/rota', headers },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

test('rateLimitPorUsuario: bloqueia o usuário no teto e devolve JSON com "error"', async () => {
  const srv = app(3).listen(0);
  const port = srv.address().port;
  try {
    for (let i = 0; i < 3; i++) {
      const r = await get(port, 111);
      assert.equal(r.status, 200, `requisição ${i + 1} deveria passar`);
    }
    const bloqueada = await get(port, 111);
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.body.error, 'devagar');
  } finally { srv.close(); }
});

test('rateLimitPorUsuario: teto é POR USUÁRIO — outro usuário não é afetado pelo bloqueio', async () => {
  const srv = app(2).listen(0);
  const port = srv.address().port;
  try {
    await get(port, 222);
    await get(port, 222);
    const bloqueada = await get(port, 222);
    assert.equal(bloqueada.status, 429, 'usuário 222 estourou o teto');

    const outroUsuario = await get(port, 333);
    assert.equal(outroUsuario.status, 200, 'usuário 333 tem o próprio teto, intacto');
  } finally { srv.close(); }
});

test('rateLimitPorUsuario: sessão de suporte (sem matrícula) usa operadorId — dois operadores diferentes têm cotas separadas', async () => {
  const srv = app(2).listen(0);
  const port = srv.address().port;
  try {
    await get(port, { operador: 901, ip: '10.0.0.1' });
    await get(port, { operador: 901, ip: '10.0.0.1' });
    const bloqueado = await get(port, { operador: 901, ip: '10.0.0.1' });
    assert.equal(bloqueado.status, 429, 'operador 901 estourou o próprio teto');

    const outroOperador = await get(port, { operador: 902, ip: '10.0.0.1' });
    assert.equal(outroOperador.status, 200, 'operador 902 (mesmo IP) tem cota separada do 901 — não divide por estar atrás do mesmo NAT');
  } finally { srv.close(); }
});

test('rateLimitPorUsuario: a mesma sessão de suporte trocando de IP continua na MESMA cota (não escapa pelo IP)', async () => {
  const srv = app(2).listen(0);
  const port = srv.address().port;
  try {
    await get(port, { operador: 903, ip: '10.1.0.1' });
    await get(port, { operador: 903, ip: '10.1.0.2' }); // trocou de IP
    const bloqueado = await get(port, { operador: 903, ip: '10.1.0.3' }); // trocou de novo
    assert.equal(bloqueado.status, 429, 'trocar de IP não deveria resetar nem escapar da cota do operador');
  } finally { srv.close(); }
});

test('rateLimitPorUsuario: prioridade da chave é matrícula/usuarioId antes de operadorId', async () => {
  const srv = app(1).listen(0);
  const port = srv.address().port;
  try {
    // Mesma matrícula, "operadorId" diferente em cada chamada — se a chave
    // priorizasse operadorId por engano, cada chamada cairia num bucket
    // diferente e nunca bloquearia.
    await get(port, { matricula: 777, operador: 1 });
    const bloqueado = await get(port, { matricula: 777, operador: 2 });
    assert.equal(bloqueado.status, 429, 'matrícula manda — operadorId não deveria criar bucket novo quando já há usuário do tenant');
  } finally { srv.close(); }
});
