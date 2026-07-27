// Testes do classificador de opt-out/opt-in (palavras-chave LGPD).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classificar, normalizar, registrarOpt } = require('../webhook/optOut');

test('classificar: opt-out reconhece variações', () => {
  assert.equal(classificar('PARAR'), 'optout');
  assert.equal(classificar('parar'), 'optout');
  assert.equal(classificar('Parar.'), 'optout');
  assert.equal(classificar('  SAIR  '), 'optout');
  assert.equal(classificar('cancelar'), 'optout');
  assert.equal(classificar('Não perturbe'), 'optout');
});

test('classificar: opt-in reconhece "VOLTAR"/"RECEBER"', () => {
  assert.equal(classificar('VOLTAR'), 'optin');
  assert.equal(classificar('quero receber'), 'optin');
});

test('classificar: ignora frase longa e texto comum (sem falso-positivo)', () => {
  assert.equal(classificar('não quero parar de comprar com vocês'), null);
  assert.equal(classificar('oi, tudo bem?'), null);
  assert.equal(classificar(''), null);
  assert.equal(classificar(null), null);
});

test('normalizar: remove acento e pontuação', () => {
  assert.equal(normalizar('São João!!'), 'SAO JOAO');
});

test('registrarOpt: optout atualiza contato e grava auditoria', async () => {
  const sqls = [];
  const conn = { async execute(sql, binds) { sqls.push({ sql, binds }); return {}; } };
  await registrarOpt(conn, {}, { contatoId: 5, telefone: '5562999990000', acao: 'optout', origem: 'whatsapp_inbound' });
  assert.match(sqls[0].sql, /UPDATE MC_ZAP_CONTATO SET OPTIN = 'N'/);
  assert.equal(sqls[0].binds.id, 5);
  assert.match(sqls[1].sql, /INSERT INTO MC_ZAP_AUDITORIA/);
  assert.equal(sqls[1].binds.acao, 'optout');
  assert.match(sqls[1].binds.det, /5562999990000/);
});

test('registrarOpt: optin marca OPTIN=S com origem', async () => {
  const sqls = [];
  const conn = { async execute(sql, binds) { sqls.push({ sql, binds }); return {}; } };
  await registrarOpt(conn, {}, { contatoId: 9, telefone: '5562988887777', acao: 'optin', origem: 'whatsapp_inbound' });
  assert.match(sqls[0].sql, /OPTIN = 'S'/);
  assert.equal(sqls[0].binds.o, 'whatsapp_inbound');
  assert.equal(sqls[1].binds.acao, 'optin');
});
