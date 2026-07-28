// Testes de CSV injection nos exports de historico.js e campanhas.js.
// NOME_PERFIL vem do WhatsApp — o contato controla o valor. Sem neutralizar,
// um perfil chamado "=cmd|'/c calc'!A1" abriria calculadora (ou pior) no
// Excel/Sheets de quem abre o export. csvEscape precisa prefixar com apóstrofo
// qualquer célula que COMECE com =, +, - ou @.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert/strict');

const historico = require('../api/historico');
const campanhas = require('../api/campanhas');

for (const [nome, mod] of [['historico', historico], ['campanhas', campanhas]]) {
  test(`${nome}.csvEscape: neutraliza fórmula (=, +, -, @) prefixando com apóstrofo`, () => {
    assert.equal(mod.csvEscape('=cmd|"/c calc"!A1'), '"\'=cmd|""/c calc""!A1"');
    assert.equal(mod.csvEscape('+55(62)99999-0000'), "'+55(62)99999-0000");
    assert.equal(mod.csvEscape('-1+1'), "'-1+1");
    assert.equal(mod.csvEscape('@SUM(A1:A9)'), "'@SUM(A1:A9)");
  });

  test(`${nome}.csvEscape: não mexe em texto normal nem em campos que só CONTÊM (não começam com) esses caracteres`, () => {
    assert.equal(mod.csvEscape('João da Silva'), 'João da Silva');
    assert.equal(mod.csvEscape('a=b'), 'a=b');
    assert.equal(mod.csvEscape('55-6299990000'), '55-6299990000');
  });

  test(`${nome}.csvEscape: continua escapando aspas/";"/quebra de linha depois de neutralizar a fórmula`, () => {
    assert.equal(mod.csvEscape('=A;B'), '"\'=A;B"');
    assert.equal(mod.csvEscape(null), '');
    assert.equal(mod.csvEscape(undefined), '');
  });
}
