// Testes de REGRESSÃO: ações em lote (forçar-transferir/forçar-finalizar)
// precisam de um SAVEPOINT por item. Sem isso, um erro de verdade num item
// deixa a transação Postgres inteira ABORTADA (25P02) — TODO item seguinte do
// lote falha também, mas por um motivo errado, e a resposta { ok, erros }
// promete um partial-success que não aconteceu de verdade.
//
// O fake abaixo simula a semântica real do Postgres (não é só pattern-match
// de SQL): uma vez "abortado", QUALQUER comando (exceto ROLLBACK TO SAVEPOINT)
// lança 25P02, exatamente como aconteceria contra um banco de verdade.
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
const { SECRET } = require('../auth/secret');
const authMiddleware = require('../auth/middleware');
const conversasRoutes = require('../api/conversas');

// tenantId no JWT: desde o FIL-67 o auth/middleware.js rejeita token sem ele.
// O tenant que este teste exercita vem do middleware de fixture abaixo, que
// roda DEPOIS do auth e sobrescreve req.tenantId por caso de teste.
const TOKEN = jwt.sign({ jti: 'tl1', tenantId: 1, matricula: 123, nome: 'Teste' }, SECRET, { expiresIn: '1h' });
const ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true };

function startApp(conn, perfil = ADMIN) {
  db.getConnection = async () => conn;
  const app = express();
  app.use('/api', express.json());
  app.use('/api/conversas', authMiddleware, (req, res, next) => { req.perfil = perfil; req.tenantId = 1; next(); }, conversasRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); }
    );
    r.on('error', reject); r.write(data); r.end();
  });
}

/** Client falso que simula a transação Postgres ficar ABORTADA depois de um
    erro de verdade num item — só ROLLBACK TO SAVEPOINT (ou ROLLBACK/COMMIT)
    volta a deixar a conexão utilizável. */
function fakeConnComAbortoPg({ idQueFalha, mensagemErro = 'erro simulado no item' } = {}) {
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
      if (/^SAVEPOINT/i.test(t) || /^RELEASE\s+SAVEPOINT/i.test(t)) { garanteVivo(); return { rows: [] }; }
      garanteVivo();

      if (sql.includes('FROM atendente WHERE matricula')) return { rows: [{ ID: 9 }] };
      if (sql.includes('SELECT departamento_id, protocolo, fila_status FROM conversa')) {
        if (binds.id === idQueFalha) { abortado = true; throw new Error(mensagemErro); }
        return { rows: [{ DEPARTAMENTO_ID: 4, PROTOCOLO: 'P1', FILA_STATUS: 'em_atendimento' }] };
      }
      if (sql.includes('SELECT contato_id, departamento_id, atendente_id, protocolo, fila_status, status FROM conversa')) {
        if (binds.id === idQueFalha) { abortado = true; throw new Error(mensagemErro); }
        return { rows: [{ CONTATO_ID: 3, DEPARTAMENTO_ID: 4, ATENDENTE_ID: 9, PROTOCOLO: 'P1', FILA_STATUS: 'em_atendimento', STATUS: 'aberta' }] };
      }
      if (sql.includes('FROM departamento WHERE id')) return { rows: [{ NOME: 'T.I' }] };
      if (sql.startsWith('UPDATE conversa')) return { rowsAffected: 1 };
      if (sql.startsWith('INSERT INTO mensagem')) return { rows: [] };
      if (sql.startsWith('INSERT INTO auditoria')) return {};
      return { rows: [], outBinds: {}, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('forcar-finalizar: erro num item usa SAVEPOINT — não aborta os itens seguintes do lote', async () => {
  const conn = fakeConnComAbortoPg({ idQueFalha: 20 });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port, '/api/conversas/forcar-finalizar', { ids: [10, 20, 30] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, 2, 'itens 10 e 30 deveriam finalizar apesar do erro no item 20');
    assert.equal(r.body.total, 3);
    const erro20 = r.body.erros.find((e) => e.id === 20);
    assert.ok(erro20, 'item 20 deve aparecer nos erros');
    assert.match(erro20.error, /erro simulado/);
    assert.equal(r.body.erros.some((e) => e.id === 30), false, 'item 30 NÃO pode falhar por causa do 20');

    assert.ok(conn.chamadas.some((c) => /^ROLLBACK\s+TO\s+SAVEPOINT/i.test(c.sql)), 'deve ter dado ROLLBACK TO SAVEPOINT após o erro');
    const updates = conn.chamadas.filter((c) => c.sql.startsWith('UPDATE conversa'));
    assert.equal(updates.length, 2, 'os dois itens bem-sucedidos devem ter chegado no UPDATE');
  } finally { server.close(); }
});

test('forcar-transferir: erro num item usa SAVEPOINT — não aborta os itens seguintes do lote', async () => {
  const conn = fakeConnComAbortoPg({ idQueFalha: 20 });
  const { server, port } = await startApp(conn);
  try {
    const r = await post(port, '/api/conversas/forcar-transferir', { ids: [10, 20, 30], departamentoId: 4 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, 2, 'itens 10 e 30 deveriam transferir apesar do erro no item 20');
    assert.equal(r.body.total, 3);
    const erro20 = r.body.erros.find((e) => e.id === 20);
    assert.ok(erro20, 'item 20 deve aparecer nos erros');
    assert.equal(r.body.erros.some((e) => e.id === 30), false, 'item 30 NÃO pode falhar por causa do 20');

    assert.ok(conn.chamadas.some((c) => /^ROLLBACK\s+TO\s+SAVEPOINT/i.test(c.sql)), 'deve ter dado ROLLBACK TO SAVEPOINT após o erro');
    const updates = conn.chamadas.filter((c) => c.sql.startsWith('UPDATE conversa'));
    assert.equal(updates.length, 2, 'os dois itens bem-sucedidos devem ter chegado no UPDATE');
  } finally { server.close(); }
});
