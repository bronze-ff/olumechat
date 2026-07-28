// FIL-77 + FIL-78 (achado de review do #22, revalidado ao integrar a
// medição de consumo): resolver o PREÇO do provedor (consumo/precos.js)
// tem exatamente o mesmo risco que resolver a CREDENCIAL tinha — as duas
// consultam tabelas fechadas ao caminho de tenant (`preco_provedor` e
// `provedor_credencial`, ambas RLS deny-all) e por isso abrem sua PRÓPRIA
// transação de operador (comOperador). Gravar consumo com tokens reais
// (registrarIaTokens) SEM cuidado prenderia 2 conexões do pool ao mesmo
// tempo pela mesma requisição — o preço buscado por baixo dos panos
// enquanto a conexão de tenant do chamador ainda está aberta.
//
// Mesmo padrão de "pool falso que conta conexões simultâneas" de
// test/ia-sem-conexao-aninhada.test.js, mas com um provedor que DEVOLVE
// `usage` — é o caminho que dispara consumo/precos.js::carregarPreco().
'use strict';
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
const precos = require('../consumo/precos');
const { cifrar } = require('../ia/credencialOperador');
const runtime = require('../ia/runtime');
const auth = require('../ia/autorizacao');
const client = require('../ia/client');
const toolExec = require('../ia/toolExecutor');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');

/** Mesmo "pool" falso de test/ia-sem-conexao-aninhada.test.js: conta quantas
 *  conexões estão abertas ao mesmo tempo e guarda o pico observado. */
function fabricarPool(handlers) {
  let abertas = 0;
  let pico = 0;
  return {
    pico: () => pico,
    getConnection: async () => {
      abertas += 1;
      pico = Math.max(pico, abertas);
      let fechada = false;
      return {
        async execute(sql) {
          for (const [padrao, resposta] of handlers) {
            if (padrao.test(sql)) return typeof resposta === 'function' ? resposta(sql) : resposta;
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

test.beforeEach(() => {
  iaConfigStore.invalidar(); iaConfigStore.invalidarGlobal(); precos.invalidarCache();
});

test('ia/runtime.processarEntrada: pico de conexões continua 1 mesmo gravando ia_tokens com custo (preço cadastrado)', async () => {
  const TENANT_ID = 5301;
  const pool = fabricarPool([
    [/ia_habilitada FROM tenant/, { rows: [{ IA_HABILITADA: 'S' }] }],
    [/FROM conversa/, { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '111', FILA_STATUS: 'ia', IA_MODO_TESTE: 'S' }] }],
    [/ia_teto_tokens_mes/, { rows: [] }],
    [/FROM ia_config/, { rows: [] }],
    [/FROM provedor_credencial WHERE ativo/, { rows: [{ PROVIDER: 'anthropic', MODELO_PADRAO: 'claude-sonnet-5', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifrar('sk-global') }] }],
    [/FROM preco_provedor WHERE/, { rows: [{ PRECO_ENTRADA_CENTAVOS_1K: 10, PRECO_SAIDA_CENTAVOS_1K: 30 }] }],
    [/MAX\(NUMERO_TURNO\)/, { rows: [{ N: 0 }] }],
    [/FROM ia_turno/, { rows: [] }],
  ]);
  db.getConnection = pool.getConnection;
  auth.autorizado = async () => true;
  const chamarOriginal = client.chamar;
  const executarOriginal = toolExec.executar;
  client.chamar = async () => ({ texto: 'ok', toolCalls: [], uso: { tokensEntrada: 400, tokensSaida: 120 } });
  toolExec.executar = async () => ({ colunas: [], linhas: [] });
  const fetchOriginal = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w' }] }) });

  try {
    await runtime.processarEntrada(TENANT_ID, 88, 'oi');
    assert.equal(pool.pico(), 1, `pico de conexões simultâneas foi ${pool.pico()}, esperava 1 — a medição de consumo reintroduziu conexão aninhada`);
  } finally {
    client.chamar = chamarOriginal;
    toolExec.executar = executarOriginal;
    global.fetch = fetchOriginal;
  }
});

function connGlobalSugestao() {
  return [
    [/SELECT id, departamento_id, numero_id, atendente_id FROM conversa/, { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: null, ATENDENTE_ID: null }] }],
    [/ia_habilitada FROM tenant/, { rows: [{ IA_HABILITADA: 'S' }] }],
    [/ia_teto_tokens_mes/, { rows: [] }],
    [/chave = 'ia_sugestao_ativa'/, { rows: [{ VALOR: 'S' }] }],
    [/FROM mensagem/, { rows: [{ DIRECAO: 'in', CONTEUDO: 'Olá' }] }],
    [/FROM ia_config/, { rows: [] }],
    [/FROM provedor_credencial WHERE ativo/, { rows: [{ PROVIDER: 'anthropic', MODELO_PADRAO: 'claude-sonnet-5', BASE_URL: null, API_KEY_CRIPTOGRAFADA: cifrar('sk-global') }] }],
    [/FROM preco_provedor WHERE/, { rows: [{ PRECO_ENTRADA_CENTAVOS_1K: 10, PRECO_SAIDA_CENTAVOS_1K: 30 }] }],
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
    const token = jwt.sign({ jti: 'ncc1', tenantId, matricula: 1, nome: 'Ana' }, SECRET, { expiresIn: '1h' });
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

test('api/conversas sugestao-resposta: pico de conexões continua 1 mesmo gravando ia_tokens com custo (preço cadastrado)', async () => {
  const TENANT_ID = 5302;
  const pool = fabricarPool(connGlobalSugestao());
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Claro!' }], usage: { input_tokens: 300, output_tokens: 80 } }) });
  const { server, port } = await startApp(pool, TENANT_ID);
  try {
    const r = await post(port, TENANT_ID);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sugestao, 'Claro!');
    assert.equal(pool.pico(), 1, `pico de conexões simultâneas foi ${pool.pico()}, esperava 1 — a medição de consumo reintroduziu conexão aninhada`);
  } finally {
    global.fetch = oldFetch;
    server.close();
  }
});
