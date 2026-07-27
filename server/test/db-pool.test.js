// Testes do boot do pool (db/pool.js). Arquivo separado de propósito: estes
// testes mexem no estado de módulo (o pool) e em DATABASE_URL, e o node:test
// roda cada arquivo em um processo próprio.
//
// O que está sendo protegido: `new Pool()` do `pg` NÃO conecta — só guarda a
// configuração. Sem a verificação do initPool(), subir com DATABASE_URL errada
// "funcionava": /health verde e webhook respondendo 200 à Meta sem conseguir
// gravar o evento.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');

// Porta 1 em loopback: recusa a conexão de imediato, sem depender de DNS nem
// de rede. É só para provar que a falha aparece no boot.
const URL_MORTA = 'postgresql://usuario:senha@127.0.0.1:1/naoexiste';

function comEnv(valores, fn) {
  const antes = {};
  for (const [k, v] of Object.entries(valores)) {
    antes[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return (async () => {
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(antes)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await db.closePool().catch(() => {});
    }
  })();
}

test('initPool: sem DATABASE_URL falha com mensagem clara', async () => {
  await comEnv({ DATABASE_URL: undefined }, async () => {
    await assert.rejects(db.initPool(), /DATABASE_URL não definida/);
  });
});

test('initPool: DATABASE_URL que não conecta falha no BOOT, não em silêncio',
  { timeout: 20_000 },
  async () => {
    await comEnv({ DATABASE_URL: URL_MORTA, DB_SKIP_HEALTHCHECK: undefined }, async () => {
      await assert.rejects(db.initPool(), /não foi possível conectar ao Postgres/);
    });
  });

test('initPool: pool com falha na verificação não fica meio-criado (retry começa limpo)',
  { timeout: 20_000 },
  async () => {
    await comEnv({ DATABASE_URL: URL_MORTA, DB_SKIP_HEALTHCHECK: undefined }, async () => {
      await assert.rejects(db.initPool(), /não foi possível conectar/);
      // Se o pool tivesse ficado guardado, a 2ª chamada devolveria ele calado.
      await assert.rejects(db.initPool(), /não foi possível conectar/);
    });
  });

test('initPool: DB_SKIP_HEALTHCHECK=1 pula a verificação (escape hatch de teste)',
  async () => {
    await comEnv({ DATABASE_URL: URL_MORTA, DB_SKIP_HEALTHCHECK: '1' }, async () => {
      const pool = await db.initPool();
      assert.ok(pool, 'deveria devolver o pool sem verificar o banco');
    });
  });
