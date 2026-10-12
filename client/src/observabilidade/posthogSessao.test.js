import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarIdentidade } from './posthogSessao.js';

function fakePosthog() {
  const chamadas = [];
  let optedOut = false;
  return {
    chamadas,
    reset() {
      chamadas.push('reset');
      optedOut = true;
    },
    opt_out_capturing() {
      chamadas.push('opt_out');
      optedOut = true;
    },
    opt_in_capturing() {
      chamadas.push('opt_in');
      optedOut = false;
    },
    has_opted_out_capturing() {
      return optedOut;
    },
    identify(id) {
      chamadas.push(`identify:${id}`);
    },
  };
}

test('primeiro identify não chama reset', () => {
  const posthog = fakePosthog();
  assert.equal(aplicarIdentidade(posthog, '', 'u:1'), 'u:1');
  assert.deepEqual(posthog.chamadas, ['identify:u:1']);
});

test('troca de usuário chama reset antes do identify', () => {
  const posthog = fakePosthog();
  assert.equal(aplicarIdentidade(posthog, 'u:1', 'o:2'), 'o:2');
  assert.deepEqual(posthog.chamadas, ['reset', 'opt_in', 'identify:o:2']);
});

test('logout chama reset e para de capturar', () => {
  const posthog = fakePosthog();
  assert.equal(aplicarIdentidade(posthog, 'u:1', ''), '');
  assert.deepEqual(posthog.chamadas, ['reset', 'opt_out']);
});

test('login depois do logout religa a captura sem alias', () => {
  const posthog = fakePosthog();
  aplicarIdentidade(posthog, 'u:1', '');
  posthog.chamadas.length = 0;
  assert.equal(aplicarIdentidade(posthog, '', 'u:9'), 'u:9');
  assert.deepEqual(posthog.chamadas, ['opt_in', 'identify:u:9']);
});
