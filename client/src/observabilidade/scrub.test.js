import test from 'node:test';
import assert from 'node:assert/strict';
import { REDACAO, permitirEvento, redigirString, urlOrigemCaminho } from './scrub.js';
import { limparEvento } from './posthogEvento.js';

test('origem e caminho, sem query', () => {
  assert.equal(
    urlOrigemCaminho('https://olumechat.com.br/conversas?ticket=abc'),
    'https://olumechat.com.br/conversas'
  );
});

test('chat e palavra sensível não seguem no evento', () => {
  const out = permitirEvento({
    event_id: 'e1',
    sdk: { name: 'sentry.javascript.react', packages: [{ name: 'token' }] },
    request: {
      url: 'https://olumechat.com.br/login?email=a@b.com',
      headers: { cookie: 'x' },
      data: { senha: 'x' },
    },
    extra: { mensagem: 'oi, tudo bem?' },
    user: { id: 'u:7', email: 'a@b.com' },
    exception: { values: [{ type: 'TypeError', value: 'não achei a conversa' }] },
  });
  assert.equal(out.event_id, 'e1');
  assert.equal(out.sdk.packages[0].name, 'token');
  assert.equal(out.request.url, 'https://olumechat.com.br/login');
  assert.equal(out.request.headers, undefined);
  assert.equal(out.request.data, undefined);
  assert.equal(out.extra, undefined);
  assert.deepEqual(out.user, { id: 'u:7' });
  assert.equal(out.exception.values[0].type, 'TypeError');
  assert.equal(out.exception.values[0].value, 'não achei a conversa');
  assert.equal(redigirString('token inválido'), REDACAO);
});

test('evento do PostHog não leva chat, query nem gravação de tela', () => {
  assert.equal(limparEvento({ event: '$snapshot', properties: { texto: 'oi' } }), null);
  const out = limparEvento({
    event: '$autocapture',
    distinct_id: 'u:7',
    properties: {
      $current_url: 'https://olumechat.com.br/conversas?ticket=abc',
      $pathname: '/conversas?x=1',
      $el_text: 'quero o cardápio',
      token: 'segredo',
      nota: 'o token expirou',
      $set: { email: 'a@b.com' },
    },
  });
  assert.equal(out.distinct_id, 'u:7');
  assert.equal(out.properties.$current_url, 'https://olumechat.com.br/conversas');
  assert.equal(out.properties.$pathname, '/conversas');
  assert.equal(out.properties.$el_text, undefined);
  assert.equal(out.properties.token, undefined);
  assert.equal(out.properties.nota, REDACAO);
  assert.deepEqual(out.properties.$set, {});
});
