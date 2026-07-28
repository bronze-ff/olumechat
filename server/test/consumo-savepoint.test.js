// FIL-77 — achado de review (P1, o mais grave): sem SAVEPOINT, um INSERT de
// consumo que falha (constraint, RLS, tabela ausente) marca a transação
// Postgres INTEIRA como abortada — capturar a exceção em JS não desfaz isso.
// Sem isolamento, a mensagem JÁ ENVIADA pelo WhatsApp sofreria ROLLBACK
// silencioso no COMMIT final: cliente recebe, sistema esquece.
//
// O fake abaixo simula a semântica REAL do Postgres (não é só pattern-match
// de SQL): uma vez "abortada", a transação rejeita QUALQUER comando (exceto
// ROLLBACK/ROLLBACK TO SAVEPOINT) com 25P02 — mesmo padrão de
// test/lote-savepoint.test.js.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.DEV_META_FALLBACK = '1';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../db/pool');
const registrar = require('../consumo/registrar');
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');

/** Client falso com a semântica de ABORTO real do Postgres: uma vez que um
 *  statement falha, tudo (exceto ROLLBACK/ROLLBACK TO SAVEPOINT) lança 25P02
 *  até um ROLLBACK (completo ou pro savepoint) acontecer. */
function fakeConnComAbortoPg(handlers = []) {
  let abortado = false;
  const chamadas = [];
  function garanteVivo() {
    if (abortado) {
      const e = new Error('current transaction is aborted, commands ignored until end of transaction block');
      e.code = '25P02';
      throw e;
    }
  }
  return {
    chamadas,
    async execute(sql, binds = {}) {
      const t = sql.trim();
      chamadas.push({ sql: t, binds });
      if (/^ROLLBACK\s+TO\s+SAVEPOINT/i.test(t)) { abortado = false; return { rows: [] }; }
      if (/^(ROLLBACK|COMMIT)\b/i.test(t)) { abortado = false; return { rows: [] }; }
      if (/^(SAVEPOINT|RELEASE\s+SAVEPOINT)/i.test(t)) { garanteVivo(); return { rows: [] }; }
      garanteVivo();
      for (const [padrao, resposta] of handlers) {
        if (padrao.test(t)) {
          if (typeof resposta === 'function') {
            try {
              return resposta(t, binds);
            } catch (err) {
              // Mesma semântica do Postgres de verdade: um statement que
              // falha (constraint, RLS, tabela ausente...) deixa a transação
              // ABORTADA — não é só "esta chamada lançou", é "tudo trava até
              // um ROLLBACK/ROLLBACK TO SAVEPOINT" (ver garanteVivo acima).
              abortado = true;
              throw err;
            }
          }
          return resposta;
        }
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('db.comSavepoint: erro dentro de fn() só aborta o SAVEPOINT — a transação do chamador segue viva', async () => {
  const conn = fakeConnComAbortoPg([
    [/^INSERT INTO falha_simulada/i, () => { throw new Error('constraint violation simulada'); }],
  ]);
  await assert.rejects(
    db.comSavepoint(conn, () => conn.execute('INSERT INTO falha_simulada VALUES (1)')),
    /constraint violation simulada/
  );
  assert.ok(conn.chamadas.some((c) => /^ROLLBACK\s+TO\s+SAVEPOINT/i.test(c.sql)), 'deveria ter dado ROLLBACK TO SAVEPOINT');
  // A transação NÃO pode estar abortada depois — comandos seguintes precisam funcionar.
  await assert.doesNotReject(conn.execute('SELECT 1'));
});

test('consumo/registrar.js::registrar: INSERT de consumo que falha usa SAVEPOINT — não propaga 25P02', async () => {
  const conn = fakeConnComAbortoPg([
    [/^INSERT INTO consumo_evento/i, () => { throw new Error('tabela consumo_evento indisponível (simulado)'); }],
  ]);
  await assert.doesNotReject(registrar.registrar(conn, 1, { tipo: 'mensagem_enviada', quantidade: 1 }));
  assert.ok(conn.chamadas.some((c) => /^ROLLBACK\s+TO\s+SAVEPOINT/i.test(c.sql)), 'registrar() precisa isolar a falha com savepoint');
  // Prova que a conexão CONTINUA usável depois — não ficou 25P02 pra sempre.
  await assert.doesNotReject(conn.execute('SELECT 1 AS ok'));
});

// ---------------------------------------------------------------------------
// Ponta a ponta: POST /api/conversas/:id/mensagens sobrevive a uma falha real
// de Postgres na gravação do consumo — a mensagem enviada NÃO pode ser
// perdida (era o pior cenário do achado de review).
// ---------------------------------------------------------------------------
const TOKEN = jwt.sign({ jti: 'sp1', tenantId: 1, matricula: 123, nome: 'Teste' }, SECRET, { expiresIn: '1h' });

function startApp(conn) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.tenantId = 1; next(); }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}
function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` } },
      (res) => { let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out || '{}') })); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

test('REGRESSÃO (P1 mais grave): POST /mensagens não perde a mensagem quando o INSERT de consumo falha de verdade (25P02 simulado)', async () => {
  const janelaExpiraEm = new Date(Date.now() + 60 * 60 * 1000);
  const conn = fakeConnComAbortoPg([
    [/SELECT id, departamento_id, numero_id, atendente_id/i, { rows: [{ ID: 7, DEPARTAMENTO_ID: null, NUMERO_ID: 2, ATENDENTE_ID: null }] }],
    [/FROM conversa c/i, { rows: [{ ID: 7, CONTATO_ID: 3, NUMERO_ID: 2, JANELA_EXPIRA_EM: janelaExpiraEm, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '5550009999' }] }],
    [/FROM atendente/i, { rows: [{ ID: 9 }] }],
    [/^INSERT INTO mensagem/i, { outBinds: { id: [42] } }],
    [/^INSERT INTO consumo_evento/i, () => { throw new Error('tabela consumo_evento indisponível (simulado)'); }],
  ]);
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }) });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port, '/api/conversas/7/mensagens', { texto: 'não pode se perder' });
    assert.equal(r.status, 201, `a mensagem TEM que ser confirmada mesmo com a medição falhando: ${JSON.stringify(r.body)}`);
    assert.ok(conn.chamadas.some((c) => /^INSERT INTO mensagem/i.test(c.sql)), 'a mensagem precisa ter sido inserida');
    assert.ok(conn.chamadas.some((c) => /^ROLLBACK\s+TO\s+SAVEPOINT/i.test(c.sql)), 'a falha na medição precisa ter sido isolada com savepoint');
    assert.ok(!conn.chamadas.some((c) => /^ROLLBACK\b/i.test(c.sql) && !/TO\s+SAVEPOINT/i.test(c.sql)), 'a transação inteira NÃO pode ter sofrido ROLLBACK completo');
  } finally {
    server.close();
  }
});
