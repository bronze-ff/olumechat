// Testes de ISOLAMENTO DE TENANT do módulo de cadastros (FIL-66).
//
// Complementa server/test/db-tenant.test.js (FIL-58, que já prova a RLS em
// si com um Postgres de mentira sobre a tabela `contato`): aqui o alvo é a
// CAMADA DE APLICAÇÃO destes endpoints — provar que:
//
//   1) departamento e tag são únicos POR TENANT: dois tenants cadastram o
//      mesmo nome e ambos têm sucesso (a unicidade da 001_inicial.sql é
//      (tenant_id, nome), não (nome) global).
//   2) numero.phone_number_id é único GLOBAL (a única exceção do schema — o
//      webhook da Meta resolve o tenant a partir dele): o segundo tenant que
//      tentar cadastrar o mesmo phoneNumberId recebe 409, e api/numeros.js
//      mapeia a violação (código 23505, constraint uq_num_pnid) corretamente.
//   3) configCache não vaza config de um tenant para outro dentro do TTL.
//
// (1) e (2) rodam contra um Postgres DE MENTIRA fiel ao suficiente (BEGIN/
// COMMIT, SET LOCAL ROLE, set_config transaction-scoped, violação de
// unicidade com código/constraint reais) e a MESMA conexão física reusada
// entre "requisições" — como o pooler faz — para também provar que o
// contexto de tenant não vaza entre elas.
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
const departamentosRoutes = require('../api/departamentos');
const tagsRoutes = require('../api/tags');
const numerosRoutes = require('../api/numeros');
const configCache = require('../utils/configCache');

const TOKEN = jwt.sign({ jti: 'ct1', matricula: 1, nome: 'Admin' }, SECRET, { expiresIn: '1h' });
const PERFIL_ADMIN = { atendenteId: 1, papel: 'ADMIN', deptoIds: [], ativo: true };

// ---------------------------------------------------------------------------
// Postgres de mentira: tabelas departamento/tag/numero com a MESMA semântica
// de escopo do db/pool.js real (set_config(...,true) transaction-scoped,
// SET LOCAL ROLE, unicidade por tenant vs. global).
// ---------------------------------------------------------------------------
function erroUnico(constraint) {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  err.code = '23505';
  err.constraint = constraint;
  return err;
}

function criarClientFalso() {
  const estado = {
    departamento: [], tag: [], numero: [],
    prox: { departamento: 1, tag: 1, numero: 1 },
    ctxTransacao: null, roleTransacao: null, emTransacao: false, comandos: [],
  };
  return {
    estado,
    async query(text, values = []) {
      estado.comandos.push(text);
      const t = text.trim();
      if (/^BEGIN/i.test(t)) { estado.emTransacao = true; return { rows: [], rowCount: 0 }; }
      if (/^(COMMIT|ROLLBACK)/i.test(t)) {
        estado.emTransacao = false; estado.ctxTransacao = null; estado.roleTransacao = null;
        return { rows: [], rowCount: 0 };
      }
      let m = /^SET\s+LOCAL\s+ROLE\s+([a-zA-Z_][\w$]*)/i.exec(t);
      if (m) { estado.roleTransacao = m[1]; return { rows: [], rowCount: 0 }; }
      if (/set_config\(/i.test(t)) { estado.ctxTransacao = values[0]; return { rows: [{ set_config: values[0] }], rowCount: 1 }; }

      const ins = /^INSERT INTO (departamento|tag|numero)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(t);
      if (ins) {
        const tabela = ins[1];
        const cols = ins[2].split(',').map((s) => s.trim());
        const linha = { tenant_id: estado.ctxTransacao, id: estado.prox[tabela]++ };
        cols.forEach((c, i) => { linha[c] = values[i]; });

        if (tabela === 'departamento' && estado.departamento.some((l) => l.tenant_id === linha.tenant_id && l.nome === linha.nome)) {
          throw erroUnico('uq_depto_nome');
        }
        if (tabela === 'tag' && estado.tag.some((l) => l.tenant_id === linha.tenant_id && l.nome === linha.nome)) {
          throw erroUnico('uq_tag_nome');
        }
        if (tabela === 'numero' && estado.numero.some((l) => l.phone_number_id === linha.phone_number_id)) {
          throw erroUnico('uq_num_pnid'); // GLOBAL: nem olha tenant_id
        }
        estado[tabela].push(linha);
        return { rows: [{ id: linha.id }], rowCount: 1, fields: [{ name: 'id' }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
}

/** Instala uma conexão FIXA (mesma conexão física para toda "requisição",
 *  como o pooler faz) embrulhada pelo wrapClient de verdade. */
function comConexaoFixa(client) {
  const original = db.getConnection;
  const conn = db._wrapClient(client);
  const semFechar = { ...conn, close: async () => { await conn.rollback(); } };
  db.getConnection = async () => semFechar;
  return () => { db.getConnection = original; };
}

function startApp(caminho, router, tenantId) {
  const app = express();
  app.use('/api', express.json());
  app.use(caminho, authMiddleware,
    (req, res, next) => { req.perfil = PERFIL_ADMIN; req.tenantId = tenantId; next(); },
    router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${TOKEN}` } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(o || '{}') })); }
    );
    rq.on('error', reject); rq.write(data); rq.end();
  });
}

test('cadastros: dois tenants criam departamento com o MESMO nome — ambos com sucesso', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    const { server: s1, port: p1 } = await startApp('/api/departamentos', departamentosRoutes, 1);
    const r1 = await post(p1, '/api/departamentos', { nome: 'Cobrança' });
    s1.close();

    const { server: s2, port: p2 } = await startApp('/api/departamentos', departamentosRoutes, 2);
    const r2 = await post(p2, '/api/departamentos', { nome: 'Cobrança' });
    s2.close();

    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    assert.notEqual(r1.body.id, r2.body.id);

    // mesmo tenant, mesmo nome de novo → CONFLITO (a unicidade é por tenant, não inexistente)
    const { server: s3, port: p3 } = await startApp('/api/departamentos', departamentosRoutes, 1);
    const r3 = await post(p3, '/api/departamentos', { nome: 'Cobrança' });
    s3.close();
    assert.equal(r3.status, 409);
  } finally {
    restaurar();
  }
});

test('cadastros: dois tenants criam tag com o MESMO nome — ambos com sucesso', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    const { server: s1, port: p1 } = await startApp('/api/tags', tagsRoutes, 10);
    const r1 = await post(p1, '/api/tags', { nome: 'Urgente' });
    s1.close();

    const { server: s2, port: p2 } = await startApp('/api/tags', tagsRoutes, 20);
    const r2 = await post(p2, '/api/tags', { nome: 'Urgente' });
    s2.close();

    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
  } finally {
    restaurar();
  }
});

test('cadastros: phone_number_id é único GLOBAL — segundo tenant recebe 409, não sobrescreve', async () => {
  const client = criarClientFalso();
  const restaurar = comConexaoFixa(client);
  try {
    const { server: s1, port: p1 } = await startApp('/api/numeros', numerosRoutes, 1);
    const r1 = await post(p1, '/api/numeros', { phoneNumberId: 'pnid-compartilhado' });
    s1.close();
    assert.equal(r1.status, 201, JSON.stringify(r1.body));

    const { server: s2, port: p2 } = await startApp('/api/numeros', numerosRoutes, 2);
    const r2 = await post(p2, '/api/numeros', { phoneNumberId: 'pnid-compartilhado' });
    s2.close();
    assert.equal(r2.status, 409, 'segundo tenant conseguiu registrar o mesmo phone_number_id — VAZAMENTO');
    assert.match(r2.body.error, /já está cadastrado/i);

    assert.equal(client.estado.numero.length, 1, 'não pode ter sobrado uma segunda linha com o número duplicado');
  } finally {
    restaurar();
  }
});

// ---------------------------------------------------------------------------
// configCache: isolamento por tenant (utils/configCache.js).
// ---------------------------------------------------------------------------
test('configCache: config do tenant A não vaza para o tenant B dentro do TTL', async () => {
  configCache.invalidar();
  const connA = { execute: async () => ({ rows: [{ CHAVE: 'despedida_padrao', VALOR: 'Tchau do A' }] }) };
  const connB = { execute: async () => ({ rows: [{ CHAVE: 'despedida_padrao', VALOR: 'Tchau do B' }] }) };

  const cfgA = await configCache.lerConfig(connA, 1);
  assert.equal(cfgA.despedida_padrao, 'Tchau do A');

  // Se a chave do cache ignorasse o tenant, esta chamada devolveria (do cache)
  // o valor do tenant A em vez de reler connB.
  const cfgB = await configCache.lerConfig(connB, 2);
  assert.equal(cfgB.despedida_padrao, 'Tchau do B', 'tenant B recebeu config cacheada do tenant A — VAZAMENTO');

  // 2ª leitura do tenant A dentro do TTL: continua vendo o próprio valor (cache por tenant, não global).
  const cfgA2 = await configCache.lerConfig({ execute: async () => { throw new Error('não deveria reler — devia vir do cache'); } }, 1);
  assert.equal(cfgA2.despedida_padrao, 'Tchau do A');

  configCache.invalidar();
});
