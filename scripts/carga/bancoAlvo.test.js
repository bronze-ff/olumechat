// scripts/carga/bancoAlvo.test.js — Testes da guarda de banco (FIL-110).
//
//   node --test scripts/carga/
//
// Não roda no job `server-test` da CI, que executa só `server/test/`. Está
// declarado no README do harness; mover a guarda para dentro de `server/`
// só para ganhar CI seria pior — o harness não é código de produto, e o
// review pediu explicitamente para não tocar em `server/`.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { autorizarBanco, BancoRecusado } = require('./bancoAlvo');

const LAB = 'postgresql://u:p@ep-shy-lake-ac5rjdix-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require';
const PROD = 'postgresql://u:p@ep-producao-exemplo.sa-east-1.aws.neon.tech/neondb?sslmode=require';

test('recusa banco da lista de proibidos mesmo com confirmação', () => {
  const env = { CARGA_LAB: '1', CARGA_BANCOS_PROIBIDOS: 'ep-producao-exemplo.sa-east-1.aws.neon.tech' };
  assert.throws(
    () => autorizarBanco({ connectionString: PROD, confirmadoPorFlag: true, env }),
    (err) => err instanceof BancoRecusado && /lista de bancos proibidos/.test(err.message)
  );
});

test('recusa sem confirmação positiva, mesmo em banco de laboratório', () => {
  assert.throws(
    () => autorizarBanco({ connectionString: LAB, env: {} }),
    (err) => err instanceof BancoRecusado && /não foi declarado como laborat/.test(err.message)
  );
});

test('aceita laboratório com CARGA_LAB=1', () => {
  const r = autorizarBanco({ connectionString: LAB, env: { CARGA_LAB: '1' } });
  assert.equal(r.host, 'ep-shy-lake-ac5rjdix-pooler.sa-east-1.aws.neon.tech');
});

test('aceita laboratório com a flag explícita', () => {
  const r = autorizarBanco({ connectionString: LAB, confirmadoPorFlag: true, env: {} });
  assert.equal(r.host, 'ep-shy-lake-ac5rjdix-pooler.sa-east-1.aws.neon.tech');
});

test('a comparação de host é por igualdade, nunca por substring', () => {
  // O host proibido é sufixo do host de laboratório. Uma checagem com
  // `includes`/`endsWith` recusaria o banco certo — é o erro que já mordeu
  // este projeto com `staging.olumechat.com.br` × `olumechat.com.br`.
  const env = { CARGA_LAB: '1', CARGA_BANCOS_PROIBIDOS: 'sa-east-1.aws.neon.tech' };
  const r = autorizarBanco({ connectionString: LAB, env });
  assert.equal(r.host, 'ep-shy-lake-ac5rjdix-pooler.sa-east-1.aws.neon.tech');
});

test('recusa DATABASE_URL ausente ou ilegível sem tentar conectar', () => {
  assert.throws(() => autorizarBanco({ connectionString: '', env: { CARGA_LAB: '1' } }), BancoRecusado);
  assert.throws(
    () => autorizarBanco({ connectionString: 'nao-e-url', env: { CARGA_LAB: '1' } }),
    (err) => err instanceof BancoRecusado && /não é uma URL válida/.test(err.message)
  );
});

test('a mensagem de recusa nunca imprime a connection string', () => {
  const comSenha = 'postgresql://usuario:SENHA_SUPER_SECRETA@ep-x.aws.neon.tech/db';
  try {
    autorizarBanco({ connectionString: comSenha, env: {} });
    assert.fail('deveria ter recusado');
  } catch (err) {
    assert.ok(!err.message.includes('SENHA_SUPER_SECRETA'));
    assert.ok(!err.message.includes('usuario:'));
    assert.ok(err.message.includes('ep-x.aws.neon.tech')); // host sim, credencial não
  }
});

test('recusa prefixo curto (a limpeza apaga por LIKE prefixo%)', () => {
  const env = { CARGA_LAB: '1' };
  assert.throws(
    () => autorizarBanco({ connectionString: LAB, prefixo: '', env }),
    (err) => err instanceof BancoRecusado && /curto demais/.test(err.message)
  );
  assert.throws(
    () => autorizarBanco({ connectionString: LAB, prefixo: 'carga', env }),
    (err) => err instanceof BancoRecusado && /curto demais/.test(err.message)
  );
});

test('recusa curinga de LIKE no prefixo', () => {
  assert.throws(
    () => autorizarBanco({ connectionString: LAB, prefixo: '%', env: { CARGA_LAB: '1' } }),
    BancoRecusado
  );
  assert.throws(
    () => autorizarBanco({ connectionString: LAB, prefixo: 'carga_fil110', env: { CARGA_LAB: '1' } }),
    (err) => err instanceof BancoRecusado && /caractere fora/.test(err.message)
  );
});

test('aceita o prefixo padrão do harness', () => {
  const { PREFIXO_PADRAO } = require('./semear');
  const r = autorizarBanco({ connectionString: LAB, prefixo: PREFIXO_PADRAO, env: { CARGA_LAB: '1' } });
  assert.equal(typeof r.host, 'string');
});
