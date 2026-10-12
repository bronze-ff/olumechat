'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { idAceito, idInterno } = require('../observabilidade/idSessao');

test('Sentry não recebe id que não seja inteiro positivo', () => {
  assert.equal(idAceito('o:ops@olume.com'), null);
  assert.equal(idAceito('u:1.5'), null);
  assert.equal(idAceito('u:0'), null);
  assert.equal(idAceito('u:-4'), null);
  assert.equal(idAceito('o:01'), null);
  assert.equal(idInterno('u', 'ana@olume.com'), null);
  assert.equal(idInterno('o', 0), null);
  assert.equal(idAceito('u:15'), 'u:15');
  assert.equal(idInterno('o', '8'), 'o:8');
});
