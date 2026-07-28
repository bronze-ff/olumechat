// Teste do POST /:id/sugestao-resposta: a conexão do pool precisa ser
// DEVOLVIDA antes de chamar o provedor de IA (a chamada externa pode levar
// até 45s — ver ia/client.js::TIMEOUT_MS). Com pool de 10, dez sugestões
// simultâneas presas dentro de db.comTenant() esgotariam o pool inteiro e
// derrubariam o webhook e o resto da API junto.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.JWT_SECRET = 'segredo-de-teste-com-mais-de-32-chars-1234567890';
// Impede que a blacklist compartilhada (utils/tokenBlacklist.js) tente
// acessar o banco real do ambiente de dev. Sem isto, se a máquina tiver um
// .env com DATABASE_URL de verdade, authMiddleware->blacklist.has() abre e
// fecha uma SEGUNDA conexão (a checagem de jti) além da do handler da rota —
// duas devoluções legítimas ao pool, mas o teste abaixo só espera uma,
// porque assume (como auth-middleware.test.js e operador-tenants.test.js já
// assumem, com o mesmo comentário) que a blacklist cai no cache local.
process.env.DATABASE_URL = '';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');
const iaConfigStore = require('../ia/iaConfigStore');
const { criptografar } = require('../ia/crypto');

// tenant exclusivo deste arquivo — evita colisão com o cache do iaConfigStore
// (TTL de 60s, chaveado por tenantId) usado por outros testes da suíte.
const TENANT_ID = 7777;
const TOKEN = jwt.sign({ jti: 'pool1', tenantId: TENANT_ID, matricula: 1, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

function fakeConn(ordem) {
  return {
    async execute(sql) {
      if (sql.includes('SELECT id, departamento_id, numero_id, atendente_id')) {
        return { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: null, ATENDENTE_ID: null }] };
      }
      if (sql.includes('ia_habilitada FROM tenant')) return { rows: [{ IA_HABILITADA: 'S' }] };
      if (sql.includes("chave = 'ia_sugestao_ativa'")) return { rows: [{ VALOR: 'S' }] };
      if (sql.includes('FROM ia_config')) {
        return {
          rows: [{
            PROVIDER: 'anthropic', MODELO: 'claude-x', BASE_URL: null,
            API_KEY_CRIPTOGRAFADA: criptografar('sk-fake', TENANT_ID),
          }],
        };
      }
      if (sql.includes('FROM mensagem')) {
        return { rows: [{ DIRECAO: 'in', CONTEUDO: 'Olá, preciso de ajuda' }] };
      }
      return { rows: [] };
    },
    async commit() {},
    async rollback() {},
    async close() { ordem.push('conexao-devolvida-ao-pool'); },
  };
}

function startApp(conn) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.tenantId = TENANT_ID; next(); }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function post(port) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({});
    const req = http.request(
      {
        method: 'POST', hostname: '127.0.0.1', port, path: '/api/conversas/7/sugestao-resposta',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('sugestao-resposta: a conexao do pool e devolvida ANTES da chamada ao provedor de IA', async () => {
  iaConfigStore.invalidar(TENANT_ID);
  const ordem = [];
  const conn = fakeConn(ordem);
  const oldFetch = global.fetch;
  global.fetch = async (url) => {
    ordem.push('chamada-externa-ao-provedor');
    assert.match(String(url), /anthropic\.com/);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Claro, posso ajudar!' }] }) };
  };
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port);
    assert.equal(r.status, 200);
    assert.equal(r.body.sugestao, 'Claro, posso ajudar!');
    // A(s) conexão(ões) do pool — a do contexto da conversa e, se precisar
    // resolver a credencial (FIL-78, ia/iaConfigStore.js, que abre a sua
    // própria transação de operador), essa também — precisam ter sido
    // devolvidas ANTES da chamada externa começar, nunca depois (senão
    // ficaram presas no pool durante o tempo de rede/LLM). Não fixamos a
    // QUANTIDADE de devoluções (pode crescer conforme a resolução da
    // credencial muda) — só que a chamada externa é sempre a ÚLTIMA coisa.
    assert.ok(ordem.length >= 2, `esperava ao menos 1 devolução de conexão + 1 chamada externa: ${JSON.stringify(ordem)}`);
    assert.deepEqual(ordem.slice(0, -1), ordem.slice(0, -1).map(() => 'conexao-devolvida-ao-pool'));
    assert.equal(ordem[ordem.length - 1], 'chamada-externa-ao-provedor');
  } finally {
    global.fetch = oldFetch;
    server.close();
    iaConfigStore.invalidar(TENANT_ID);
  }
});
