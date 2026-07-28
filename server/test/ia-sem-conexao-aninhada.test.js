'use strict';
// FIL-78 (achado de review, P1): resolver a credencial (chave própria do
// tenant OU credencial global do operador) não pode segurar duas conexões do
// pool ao mesmo tempo — com pool pequeno ou N cache-misses simultâneos, cada
// requisição prendendo 2 conexões esgota o pool e tudo trava esperando
// conexões que os próprios chamadores seguram. Este arquivo prova, num pool
// FALSO que conta conexões abertas simultaneamente, que o pico nunca passa
// de 1 — nem em ia/iaConfigStore.js isolado, nem no fluxo inteiro do bot
// (ia/runtime.js) nem no da sugestão de resposta (api/conversas.js).
process.env.META_APP_SECRET = 'x'; process.env.WEBHOOK_VERIFY_TOKEN = 'x'; process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = 'x'; process.env.WA_BUSINESS_ACCOUNT_ID = 'x';
process.env.JWT_SECRET = 'segredo-de-teste-com-mais-de-32-chars-1234567890';
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const iaConfigStore = require('../ia/iaConfigStore');
const { cifrar } = require('../ia/credencialOperador');
const { criptografar } = require('../ia/crypto');
const runtime = require('../ia/runtime');
const auth = require('../ia/autorizacao');
const historico = require('../ia/historico');
const client = require('../ia/client');
const toolExec = require('../ia/toolExecutor');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');

/** "Pool" falso: conta quantas conexões estão abertas ao mesmo tempo (nunca
 *  cai, mesmo que o mock devolva um NOVO objeto a cada chamada) e guarda o
 *  pico observado durante o teste inteiro. */
function fabricarPool(handlers) {
  let abertas = 0;
  let pico = 0;
  const chamadas = [];
  return {
    pico: () => pico,
    chamadas,
    getConnection: async () => {
      abertas += 1;
      pico = Math.max(pico, abertas);
      let fechada = false;
      return {
        async execute(sql, binds) {
          chamadas.push(sql);
          for (const [padrao, resposta] of handlers) {
            if (padrao.test(sql)) return typeof resposta === 'function' ? resposta(sql, binds) : resposta;
          }
          return { rows: [] };
        },
        async commit() {},
        async rollback() {},
        async close() {
          if (fechada) return;
          fechada = true;
          abertas -= 1;
        },
      };
    },
  };
}

test('ia/iaConfigStore.carregar: nunca duas conexões abertas ao mesmo tempo (tenant sem chave própria, cai pro global)', async () => {
  iaConfigStore.invalidar(); iaConfigStore.invalidarGlobal();
  const pool = fabricarPool([
    [/FROM ia_config/, { rows: [] }],
    [/FROM provedor_credencial WHERE ativo/, { rows: [{ PROVIDER: 'anthropic', MODELO_PADRAO: 'm', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifrar('sk-global') }] }],
  ]);
  db.getConnection = pool.getConnection;
  const cfg = await iaConfigStore.carregar(4242);
  assert.equal(cfg.apiKey, 'sk-global');
  assert.equal(pool.pico(), 1, `pico de conexões simultâneas foi ${pool.pico()}, esperava 1`);
});

test('ia/iaConfigStore.carregar: nunca duas conexões abertas ao mesmo tempo (tenant COM chave própria)', async () => {
  iaConfigStore.invalidar(); iaConfigStore.invalidarGlobal();
  const pool = fabricarPool([
    [/FROM ia_config/, { rows: [{ PROVIDER: 'openai', MODELO: 'gpt-4o', BASE_URL: null, API_KEY_CRIPTOGRAFADA: criptografar('sk-tenant', 4243) }] }],
  ]);
  db.getConnection = pool.getConnection;
  const cfg = await iaConfigStore.carregar(4243);
  assert.equal(cfg.apiKey, 'sk-tenant');
  assert.equal(pool.pico(), 1, `pico de conexões simultâneas foi ${pool.pico()}, esperava 1`);
});

test('ia/runtime.processarEntrada: pico de conexões simultâneas é 1 do início ao fim (tenant sem chave própria)', async () => {
  iaConfigStore.invalidar(); iaConfigStore.invalidarGlobal();
  const TENANT_ID = 4244;
  const pool = fabricarPool([
    [/ia_habilitada FROM tenant/, { rows: [{ IA_HABILITADA: 'S' }] }],
    [/FROM conversa/, { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '111' }] }],
    [/ia_teto_tokens_mes/, { rows: [] }],
    [/FROM ia_config/, { rows: [] }],
    [/FROM provedor_credencial WHERE ativo/, { rows: [{ PROVIDER: 'anthropic', MODELO_PADRAO: 'm', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifrar('sk-global') }] }],
    [/MAX\(NUMERO_TURNO\)/, { rows: [{ N: 0 }] }],
    [/FROM ia_turno/, { rows: [] }],
  ]);
  db.getConnection = pool.getConnection;
  auth.autorizado = async () => true;
  // client.chamar/toolExec.executar são singletons de módulo — restaurados no
  // finally pra não vazar mock pro próximo teste deste arquivo (que exercita
  // o client.chamar DE VERDADE via sugestaoResposta.gerarComContexto).
  const chamarOriginal = client.chamar;
  const executarOriginal = toolExec.executar;
  client.chamar = async () => ({ texto: 'ok', toolCalls: [] });
  toolExec.executar = async () => ({ colunas: [], linhas: [] });
  const fetchOriginal = global.fetch;
  global.fetch = async (u, o) => ({ ok: true, json: async () => ({ messages: [{ id: 'w' }] }) });

  try {
    await runtime.processarEntrada(TENANT_ID, 88, 'oi');
    assert.equal(pool.pico(), 1, `pico de conexões simultâneas foi ${pool.pico()}, esperava 1 — houve conexão aninhada`);
  } finally {
    client.chamar = chamarOriginal;
    toolExec.executar = executarOriginal;
    global.fetch = fetchOriginal;
  }
});

function connGlobalSugestao(TENANT_ID) {
  return [
    [/SELECT id, departamento_id, numero_id, atendente_id FROM conversa/, { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: null, ATENDENTE_ID: null }] }],
    [/ia_habilitada FROM tenant/, { rows: [{ IA_HABILITADA: 'S' }] }],
    [/ia_teto_tokens_mes/, { rows: [] }],
    [/chave = 'ia_sugestao_ativa'/, { rows: [{ VALOR: 'S' }] }],
    [/FROM mensagem/, { rows: [{ DIRECAO: 'in', CONTEUDO: 'Olá' }] }],
    [/FROM ia_config/, { rows: [] }],
    [/FROM provedor_credencial WHERE ativo/, { rows: [{ PROVIDER: 'anthropic', MODELO_PADRAO: 'claude-sonnet-5', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifrar('sk-global') }] }],
  ];
}

function startApp(pool, tenantId) {
  db.getConnection = pool.getConnection;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.tenantId = tenantId; next(); }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}
function post(port, tenantId) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({});
    const token = jwt.sign({ jti: 'nc1', tenantId, matricula: 1, nome: 'Ana' }, SECRET, { expiresIn: '1h' });
    const req = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path: '/api/conversas/7/sugestao-resposta',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${token}` } },
      (res) => { let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') })); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('api/conversas sugestao-resposta: pico de conexões simultâneas é 1, mesmo caindo pro fallback global', async () => {
  iaConfigStore.invalidar(); iaConfigStore.invalidarGlobal();
  const TENANT_ID = 4245;
  const pool = fabricarPool(connGlobalSugestao(TENANT_ID));
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Claro!' }] }) });
  const { server, port } = await startApp(pool, TENANT_ID);
  try {
    const r = await post(port, TENANT_ID);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sugestao, 'Claro!');
    assert.equal(pool.pico(), 1, `pico de conexões simultâneas foi ${pool.pico()}, esperava 1 — houve conexão aninhada`);
  } finally {
    global.fetch = oldFetch;
    server.close();
  }
});
