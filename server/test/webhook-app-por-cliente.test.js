// FIL-97 — webhook POR CAMINHO, com App Secret por cliente.
//
// O que está sendo protegido aqui: com um app da Meta por cliente, o App Secret
// deixa de ser único da Olume. A assinatura passa a provar apenas "veio do app
// DAQUELE cliente" — nunca de quem é o conteúdo. Os testes cobrem os dois lados
// disso:
//
//   1. o caminho identifica o tenant ANTES de qualquer parsing, e cada tenant só
//      é validado com o segredo dele (o do vizinho não serve);
//   2. uma assinatura legítima de um cliente NÃO escreve na empresa de outro —
//      change de outro tenant é descartado antes de tocar em qualquer tabela.
//
// Roda sem banco e sem rede: as conexões são dublês, como no resto da suíte.
'use strict';

process.env.META_APP_SECRET = 'segredo-global-da-plataforma';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.JWT_SECRET = 'master-secret-de-teste-com-tamanho-suficiente';
process.env.IA_CRYPTO_KEY = 'chave-de-teste-dedicada-com-tamanho-ok-32+';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const db = require('../db/pool');
const appCliente = require('../meta/appCliente');
const { criptografar } = require('../ia/crypto');
const { buildWebhookRouter } = require('../webhook/routes');
const eventoStore = require('../webhook/eventoStore');
const processEvent = require('../webhook/processEvent');
const durabilidade = require('../webhook/durabilidade');
const { processPayload } = processEvent;

const A = 11;
const B = 22;
const IDENT_A = 'a'.repeat(32);
const IDENT_B = 'b'.repeat(32);
const SEGREDO_A = 'app-secret-do-cliente-A';
const SEGREDO_B = 'app-secret-do-cliente-B';

function assinar(body, segredo) {
  return 'sha256=' + crypto.createHmac('sha256', segredo).update(body).digest('hex');
}

/** Banco de mentira: meta_conexao com os dois clientes + webhook_evento. */
function fakeDb(estado) {
  const conexoes = [
    { TENANT_ID: A, APP_ID: 'app-A', WEBHOOK_IDENTIFICADOR: IDENT_A,
      APP_SECRET_CRIPTOGRAFADO: criptografar(SEGREDO_A, A, undefined, appCliente.CONTEXTO) },
    { TENANT_ID: B, APP_ID: 'app-B', WEBHOOK_IDENTIFICADOR: IDENT_B,
      APP_SECRET_CRIPTOGRAFADO: criptografar(SEGREDO_B, B, undefined, appCliente.CONTEXTO) },
  ];
  db.getConnection = async () => ({
    async execute(sql, binds) {
      if (/FROM meta_conexao/i.test(sql)) {
        const row = conexoes.find((c) => c.WEBHOOK_IDENTIFICADOR === binds.ident);
        return { rows: row ? [row] : [] };
      }
      if (/INSERT INTO webhook_evento/i.test(sql)) {
        estado.inseridos.push(binds);
        return { rows: [{ ID: estado.inseridos.length }], rowsAffected: 1 };
      }
      return { rows: [], rowsAffected: 0 };
    },
    async commit() {}, async rollback() {}, async close() {},
  });
}

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, hostname: '127.0.0.1', port, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function comServidor(fn) {
  const estado = { inseridos: [] };
  const oldGetConnection = db.getConnection;
  fakeDb(estado);
  const app = express();
  app.use('/', buildWebhookRouter({ verifyToken: 'verify123', appSecret: process.env.META_APP_SECRET }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    return await fn(server.address().port, estado);
  } finally {
    server.close();
    db.getConnection = oldGetConnection;
  }
}

const CORPO = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

// ===================== identificador =====================
test('identificador é opaco (32 hex) e não deriva do tenant', () => {
  const a = appCliente.gerarIdentificador();
  const b = appCliente.gerarIdentificador();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b, 'dois clientes não podem receber o mesmo caminho');
  assert.ok(appCliente.identificadorValido(a));
  // O que o webhook recusa sem sequer ir ao banco.
  for (const ruim of ['', 'slug-do-cliente', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '../webhook']) {
    assert.equal(appCliente.identificadorValido(ruim), false, `aceitou "${ruim}"`);
  }
});

// ===================== assinatura por tenant =====================
test('POST /webhook/<ident>: assinatura com o segredo do PRÓPRIO tenant é aceita', async () => {
  await comServidor(async (port, estado) => {
    const r = await request(port, 'POST', `/webhook/${IDENT_A}`, {
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(CORPO, SEGREDO_A) },
      body: CORPO,
    });
    assert.equal(r.status, 200);
    // O evento nasce amarrado ao tenant do CAMINHO.
    assert.equal(estado.inseridos.length, 1);
    assert.equal(estado.inseridos[0].tenantId, A);
  });
});

test('POST /webhook/<ident>: segredo do tenant A não valida no caminho do tenant B', async () => {
  await comServidor(async (port, estado) => {
    const r = await request(port, 'POST', `/webhook/${IDENT_B}`, {
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(CORPO, SEGREDO_A) },
      body: CORPO,
    });
    assert.equal(r.status, 401);
    assert.equal(estado.inseridos.length, 0, 'assinatura inválida não pode persistir evento');
  });
});

test('POST /webhook/<ident>: o segredo GLOBAL não vale no caminho de um cliente', async () => {
  await comServidor(async (port) => {
    const r = await request(port, 'POST', `/webhook/${IDENT_A}`, {
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(CORPO, process.env.META_APP_SECRET) },
      body: CORPO,
    });
    assert.equal(r.status, 401);
  });
});

test('POST /webhook/<ident>: caminho inexistente é 404 e não revela nada', async () => {
  await comServidor(async (port, estado) => {
    const desconhecido = 'c'.repeat(32);
    const r = await request(port, 'POST', `/webhook/${desconhecido}`, {
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(CORPO, SEGREDO_A) },
      body: CORPO,
    });
    assert.equal(r.status, 404);
    assert.equal(r.body, 'Not Found', 'a resposta não pode contar se o cliente existe');
    assert.equal(estado.inseridos.length, 0);

    // Caminho fora do formato nem chega ao banco — mesma resposta.
    const torto = await request(port, 'POST', '/webhook/nao-e-hex', {
      headers: { 'content-type': 'application/json' }, body: CORPO,
    });
    assert.equal(torto.status, 404);
  });
});

// ===================== compatibilidade =====================
test('o webhook GLOBAL continua funcionando com o META_APP_SECRET', async () => {
  await comServidor(async (port, estado) => {
    const r = await request(port, 'POST', '/webhook', {
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(CORPO, process.env.META_APP_SECRET) },
      body: CORPO,
    });
    assert.equal(r.status, 200);
    assert.equal(estado.inseridos.length, 1);
    assert.equal(estado.inseridos[0].tenantId, null, 'evento do caminho global não é amarrado a tenant');

    // E o segredo de um cliente não abre o caminho global.
    const cliente = await request(port, 'POST', '/webhook', {
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(CORPO, SEGREDO_A) },
      body: CORPO,
    });
    assert.equal(cliente.status, 401);
  });
});

// ===================== verificação (GET) =====================
test('GET /webhook/<ident>: devolve o challenge com o verify token; caminho desconhecido é 404', async () => {
  await comServidor(async (port) => {
    const ok = await request(port, 'GET',
      `/webhook/${IDENT_A}?hub.mode=subscribe&hub.verify_token=verify123&hub.challenge=DESAFIO`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'DESAFIO');

    const tokenErrado = await request(port, 'GET',
      `/webhook/${IDENT_A}?hub.mode=subscribe&hub.verify_token=ERRADO&hub.challenge=DESAFIO`);
    assert.equal(tokenErrado.status, 403);

    const desconhecido = await request(port, 'GET',
      `/webhook/${'d'.repeat(32)}?hub.mode=subscribe&hub.verify_token=verify123&hub.challenge=DESAFIO`);
    assert.equal(desconhecido.status, 404);
  });
});

// ===================== chave idempotente =====================
test('chave idempotente é por caminho: o tenant A não colapsa o evento do tenant B', () => {
  const payload = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.MESMO' }] } }] }] };
  const bruto = Buffer.from(JSON.stringify(payload));
  const chaveA = eventoStore.chaveIdempotente(bruto, payload, A);
  const chaveB = eventoStore.chaveIdempotente(bruto, payload, B);
  const chaveGlobal = eventoStore.chaveIdempotente(bruto, payload);
  assert.notEqual(chaveA, chaveB, 'um cliente poderia afogar o evento real do outro');
  assert.notEqual(chaveA, chaveGlobal);
  // Reentrega da MESMA origem continua colapsando (é o ponto da chave).
  assert.equal(chaveA, eventoStore.chaveIdempotente(bruto, payload, A));
  // E o caminho global mantém a chave EXATA de antes deste ticket.
  assert.equal(chaveGlobal, 'ev:' + crypto.createHash('sha256').update('m:wamid.MESMO').digest('hex'));
});

// ===================== isolamento no processamento =====================
test('assinatura de um cliente NÃO escreve na empresa de outro (change descartado)', async () => {
  const escritas = [];
  const oldGetConnection = db.getConnection;
  const oldComTenant = db.comTenant;
  // O número do payload pertence ao tenant B.
  db.getConnection = async () => ({
    async execute(sql) {
      if (/FROM\s+numero/i.test(sql)) {
        return { rows: [{ ID: 9, TENANT_ID: B, DEPARTAMENTO_PADRAO_ID: null, MODO: 'padrao', FLUXO_ID: null }] };
      }
      return { rows: [] };
    },
    async close() {},
  });
  // O que importa aqui é EM QUAL empresa uma transação chega a abrir — o miolo
  // do processChange já é coberto por processEvent.test.js. Por isso o dublê
  // registra e não executa: o teste isola a guarda, não a ingestão.
  db.comTenant = async (tenantId) => {
    escritas.push(tenantId);
    return [];
  };
  const payload = {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN-DO-B' }, messages: [{ id: 'w1', from: '5562999990000', type: 'text', text: { body: 'oi' } }] } }] }],
  };
  try {
    // Chegou pelo caminho do tenant A (assinado com o segredo de A).
    await processPayload(payload, { tenantEsperado: A });
    assert.deepEqual(escritas, [], 'nenhuma transação pode abrir na empresa do vizinho');

    // O mesmo payload pelo caminho do DONO passa normalmente.
    await processPayload(payload, { tenantEsperado: B });
    assert.deepEqual(escritas, [B]);

    // E o webhook global (sem tenant amarrado) segue como sempre foi.
    await processPayload(payload);
    assert.deepEqual(escritas, [B, B]);
  } finally {
    db.getConnection = oldGetConnection;
    db.comTenant = oldComTenant;
  }
});

// ===================== replay =====================
test('a recuperação reprocessa com o MESMO tenant do caminho de entrada', async () => {
  // O POST original amarra o evento ao tenant do caminho; a varredura roda
  // muito depois (processo morto no meio) e precisa amarrar de novo — senão o
  // replay aceitaria um change que a primeira passada teria descartado.
  const originais = {
    candidatosOrfaos: eventoStore.candidatosOrfaos,
    reivindicarOrfao: eventoStore.reivindicarOrfao,
    concluir: eventoStore.concluir,
    pendentes: eventoStore.pendentes,
    purgarConcluidos: eventoStore.purgarConcluidos,
    finalizarEncalhados: eventoStore.finalizarEncalhados,
    processPayload: processEvent.processPayload,
  };
  const vistos = [];
  eventoStore.candidatosOrfaos = async () => ([
    { id: 1, payload: '{"entry":[]}', tentativas: 1, webhookTenantId: A },
    { id: 2, payload: '{"entry":[]}', tentativas: 1, webhookTenantId: null },
  ]);
  eventoStore.reivindicarOrfao = async () => true;
  eventoStore.concluir = async () => ({ atrasoMs: 1, concluido: true });
  eventoStore.pendentes = async () => ({ total: 0, maisAntigoSeg: 0, falhas: 0 });
  eventoStore.purgarConcluidos = async () => 0;
  eventoStore.finalizarEncalhados = async () => [];
  processEvent.processPayload = async (_payload, opts) => {
    vistos.push(opts.tenantEsperado);
    return { despachados: 0, pendentes: 0 };
  };
  try {
    await durabilidade.varrer();
    assert.deepEqual(vistos, [A, null], 'o tenant do caminho tem que sobreviver ao replay');
  } finally {
    Object.assign(eventoStore, {
      candidatosOrfaos: originais.candidatosOrfaos,
      reivindicarOrfao: originais.reivindicarOrfao,
      concluir: originais.concluir,
      pendentes: originais.pendentes,
      purgarConcluidos: originais.purgarConcluidos,
      finalizarEncalhados: originais.finalizarEncalhados,
    });
    processEvent.processPayload = originais.processPayload;
    durabilidade.zerarMetricas();
  }
});
