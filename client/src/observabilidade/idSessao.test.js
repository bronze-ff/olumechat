import test from 'node:test';
import assert from 'node:assert/strict';
import { idAceito, idDaSessao, idInterno } from './idSessao.js';

function tokenForjado(payload) {
  const parte = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${parte({ alg: 'none', typ: 'JWT' })}.${parte(payload)}.`;
}

test('token forjado não identifica, mesmo com e-mail no operadorId', () => {
  const token = tokenForjado({
    operadorId: 'ops@olume.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.equal(idDaSessao({ token, resposta: null, prefixo: 'o' }), null);
  assert.equal(idDaSessao({
    token,
    resposta: { id: 'ops@olume.com', email: 'ops@olume.com', nome: 'Ops' },
    prefixo: 'o',
  }), null);
  assert.equal(idDaSessao({
    token,
    resposta: { id: 7, email: 'ops@olume.com', nome: 'Ops' },
    prefixo: 'o',
  }), 'o:7');
});

test('id que não é inteiro positivo não identifica', () => {
  for (const valor of ['ops@olume.com', '1abc', '01', '1.5', 0, -3, 1.5, true, null, '', '1e2']) {
    assert.equal(idInterno('o', valor), null, String(valor));
    assert.equal(idInterno('u', valor), null, String(valor));
  }
  assert.equal(idAceito('o:ops@olume.com'), null);
  assert.equal(idAceito('u:0'), null);
  assert.equal(idAceito('u:-1'), null);
  assert.equal(idAceito('email:1'), null);
  assert.equal(idInterno('u', 42), 'u:42');
  assert.equal(idAceito('o:42'), 'o:42');
  assert.equal(idDaSessao({
    resposta: { suporte: true, operadorId: '9', nome: 'Suporte Olume (ops@olume.com)' },
    prefixo: 'o',
  }), 'o:9');
  assert.equal(idDaSessao({
    resposta: { suporte: true, operadorId: 'ops@olume.com' },
    prefixo: 'o',
  }), null);
});
