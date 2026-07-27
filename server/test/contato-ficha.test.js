// Testes da ficha do contato: seam de auto-identificação + API /contatos.
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

const db = require('../db/pool');
const {
  partesTelefone, acharClientePorTelefone, dadosClienteWinthor, registrarProvedor,
} = require('../utils/clienteLookup');
const contatosRoutes = require('../api/contatos');

// ---------- clienteLookup (unidade) ----------

test('partesTelefone: 9º dígito e DDI 55 são invariantes (mesmo last8/nat10)', () => {
  const com9 = partesTelefone('5562999990000');   // 13 díg
  const sem9 = partesTelefone('556299990000');     // 12 díg
  assert.equal(com9.last8, sem9.last8);
  assert.equal(com9.nat10, sem9.nat10);
  assert.equal(com9.ddd, '62');
  assert.equal(com9.last8, '99990000');
  assert.equal(com9.nat10, '6299990000');
});

test('partesTelefone: telefone curto demais (sem DDD) → null', () => {
  assert.equal(partesTelefone('99990000'), null);
});

// O produto não embute integração com ERP: clienteLookup é um SEAM. Estes testes
// cobrem o contrato do seam — sem provedor devolve null, e um provedor quebrado
// NUNCA pode derrubar a ingestão da mensagem.

test('acharClientePorTelefone: sem provedor registrado → null', async () => {
  registrarProvedor(null);
  assert.equal(await acharClientePorTelefone({}, '5562999990000'), null);
});

test('acharClientePorTelefone: com provedor → devolve o que o provedor achou', async () => {
  registrarProvedor({ async acharPorTelefone(tel) { return { codigo: 10, nome: 'ACME', documento: '111', tel }; } });
  try {
    const r = await acharClientePorTelefone({}, '5562999990000');
    assert.equal(r.codigo, 10);
    assert.equal(r.nome, 'ACME');
  } finally { registrarProvedor(null); }
});

test('acharClientePorTelefone: provedor que lança → null, não derruba a ingestão', async () => {
  registrarProvedor({ async acharPorTelefone() { throw new Error('ERP fora do ar'); } });
  try {
    assert.equal(await acharClientePorTelefone({}, '5562999990000'), null);
  } finally { registrarProvedor(null); }
});

test('dadosClienteWinthor: sem provedor ou sem código → null', async () => {
  registrarProvedor(null);
  assert.equal(await dadosClienteWinthor({}, 10), null);
  registrarProvedor({ async dadosDoCliente() { return { vendedor: 'x' }; } });
  try {
    assert.equal(await dadosClienteWinthor({}, null), null);
    assert.deepEqual(await dadosClienteWinthor({}, 10), { vendedor: 'x' });
  } finally { registrarProvedor(null); }
});

// ---------- API /api/contatos (integração leve) ----------

function fakeConn({ contato = { ID: 5, TELEFONE: '5562999990000', NOME_PERFIL: null, NOME_INTERNO: null, CODIGO_EXTERNO: null, DOCUMENTO: null, OBSERVACOES: null, TAGS_CONTATO: null, ATUALIZADO_EM: null, ATUALIZADO_POR_NOME: null }, cap = {} } = {}) {
  return {
    async execute(sql, binds) {
      if (sql.includes('FROM contato ct')) return { rows: contato ? [contato] : [] };
      if (sql.startsWith('UPDATE contato')) { cap.update = binds; return { rowsAffected: 1 }; }
      if (sql.includes('INSERT INTO auditoria')) { cap.audit = binds; return {}; }
      return { rows: [], outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function app(conn, perfil = { atendenteId: 9, papel: 'ADMIN', deptoIds: [], numeroIds: [] }) {
  db.getConnection = async () => conn;
  const a = express();
  a.use(express.json());
  a.use('/api/contatos', (req, res, next) => { req.perfil = perfil; req.user = { matricula: 123 }; req.tenantId = 1; next(); }, contatosRoutes);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => { const s = a.listen(0, () => resolve({ server: s, port: s.address().port })); });
}

function req(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, hostname: '127.0.0.1', port, path,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test('PUT /contatos/:id persiste nome interno + grava auditoria', async () => {
  const cap = {};
  const { server, port } = await app(fakeConn({ cap }));
  try {
    const r = await req(port, 'PUT', '/api/contatos/5', { nomeInterno: 'Padaria do João', codigoExterno: 1234, tags: [1, 2] });
    assert.equal(r.status, 200);
    assert.equal(cap.update.cod.val, 1234);        // codigo_externo bindado como número
    assert.equal(cap.update.tags, '[1,2]');         // tags viram JSON
    assert.equal(cap.audit.ENTIDADE ?? 'contato', 'contato');
    assert.match(String(cap.audit.det), /Padaria do João/);
  } finally { server.close(); }
});

test('PUT /contatos/:id: AUDITOR (somente-leitura) → 403', async () => {
  const { server, port } = await app(fakeConn(), { atendenteId: 1, papel: 'AUDITOR', deptoIds: [], numeroIds: [] });
  try {
    const r = await req(port, 'PUT', '/api/contatos/5', { nomeInterno: 'x' });
    assert.equal(r.status, 403);
  } finally { server.close(); }
});

test('GET /contatos/:id: contato inexistente → 404', async () => {
  const { server, port } = await app(fakeConn({ contato: null }));
  try {
    const r = await req(port, 'GET', '/api/contatos/999');
    assert.equal(r.status, 404);
  } finally { server.close(); }
});
