// Contratos da blacklist compartilhada: instâncias distintas não compartilham
// memória, mas consultam o mesmo armazenamento; expirados são removidos.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const operadorDb = require('../operador/db');

const original = {
  databaseUrl: process.env.DATABASE_URL,
  comTenant: db.comTenant,
  comOperador: operadorDb.comOperador,
};
const rows = new Map();

function connection(tenantId = null) {
  return {
    async execute(sql, binds = {}) {
      if (/^INSERT/i.test(sql)) {
        rows.set(binds.jti, { tenantId, expiraEm: new Date(binds.expiraEm) });
        return { rows: [], rowsAffected: 1 };
      }
      if (/^DELETE/i.test(sql)) {
        let n = 0;
        for (const [jti, row] of rows) {
          if (row.expiraEm <= new Date()) { rows.delete(jti); n++; }
        }
        return { rows: [], rowsAffected: n };
      }
      const row = rows.get(binds.jti);
      return { rows: row && row.tenantId === tenantId && row.expiraEm > new Date() ? [{}] : [] };
    },
  };
}

test.before(() => {
  process.env.DATABASE_URL = 'postgres://teste';
  db.comTenant = async (tenantId, fn) => fn(connection(tenantId));
  operadorDb.comOperador = async (fn) => fn(connection(null));
});

test.after(() => {
  if (original.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original.databaseUrl;
  db.comTenant = original.comTenant;
  operadorDb.comOperador = original.comOperador;
});

test('logout na instância A invalida o mesmo token na instância B', async () => {
  const caminho = require.resolve('../utils/tokenBlacklist');
  delete require.cache[caminho];
  const blacklistA = require(caminho);
  delete require.cache[caminho];
  const blacklistB = require(caminho);

  await blacklistA.add('jti-compartilhado', Math.floor(Date.now() / 1000) + 60, { tenantId: 1 });
  assert.equal(await blacklistB.has('jti-compartilhado', { tenantId: 1 }), true);
  assert.equal(await blacklistB.has('jti-compartilhado', { tenantId: 2 }), false);
});

test('limparExpirados remove entradas vencidas', async () => {
  const blacklist = require('../utils/tokenBlacklist');
  await blacklist.add('jti-expirando', Math.floor(Date.now() / 1000), { tenantId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await blacklist.limparExpirados(), 1);
  assert.equal(rows.has('jti-expirando'), false);
});
