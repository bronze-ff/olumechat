'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  REDACAO,
  redigirString,
  urlOrigemCaminho,
  permitirEvento,
  permitirBreadcrumb,
  limparSpan,
} = require('../observabilidade/scrub');

function eventoCheio() {
  return {
    event_id: 'evt-1',
    timestamp: 1,
    platform: 'node',
    level: 'error',
    sdk: { name: 'sentry.javascript.node', version: '11.7.0', packages: [{ name: 'token-pkg' }] },
    environment: 'dev',
    release: 'abc',
    transaction: 'POST https://api.olumechat.com.br/webhook/abc?token=segredo',
    request: {
      method: 'POST',
      url: 'https://api.olumechat.com.br/api/conversas?ticket=abc&token=segredo#frag',
      headers: { authorization: 'Bearer abc', cookie: 'a=b' },
      cookies: { session: 'x' },
      query_string: 'token=segredo',
      data: { messages: [{ text: { body: 'oi, meu cpf é 123.456.789-09' } }] },
    },
    extra: { mensagem: 'quero o cardápio de segunda' },
    user: { id: 'u:42', email: 'a@b.com', username: 'Ana', ip_address: '1.1.1.1' },
    tags: { rota: '/conversas', authorization: 'Bearer x' },
    exception: {
      values: [{
        type: 'Error',
        value: 'falha ao validar token do webhook',
        mechanism: { type: 'generic', handled: false, data: { body: 'oi' } },
        stacktrace: {
          frames: [{
            filename: 'app.js',
            function: 'handler',
            lineno: 10,
            colno: 2,
            in_app: true,
            vars: { texto: 'olá cliente, telefone 11988887777' },
            context_line: 'const segredo = token',
          }],
        },
      }],
    },
    breadcrumbs: [
      { type: 'console', category: 'console', level: 'info', message: 'cliente disse oi', timestamp: 1 },
      {
        type: 'http',
        category: 'http',
        level: 'info',
        timestamp: 2,
        message: 'https://api.olumechat.com.br/api/stream?ticket=abc',
        data: { body: 'mensagem de chat', 'http.query': 'ticket=abc' },
      },
    ],
  };
}

test('URL fica só com origem e caminho', () => {
  assert.equal(
    urlOrigemCaminho('https://api.olumechat.com.br/api/conversas/1?ticket=abc#x'),
    'https://api.olumechat.com.br/api/conversas/1'
  );
  assert.equal(urlOrigemCaminho('/api/stream?ticket=abc'), '/api/stream');
});

test('palavra sensível redige a string inteira', () => {
  assert.equal(redigirString('falha ao validar token do webhook'), REDACAO);
  assert.equal(redigirString('senha123'), REDACAO);
  assert.equal(redigirString('access_token expirado'), REDACAO);
  assert.equal(redigirString('secretaria do cliente'), 'secretaria do cliente');
  assert.equal(redigirString('erro de validação'), 'erro de validação');
});

test('dado pessoal redige a string inteira', () => {
  assert.equal(redigirString('cpf 123.456.789-09'), REDACAO);
  assert.equal(redigirString('cnpj 12.345.678/0001-95'), REDACAO);
  assert.equal(redigirString('escreva para ana@olumechat.com.br'), REDACAO);
  assert.equal(redigirString('liga no (11) 98888-7777'), REDACAO);
  assert.equal(redigirString('placa ABC1D23'), REDACAO);
});

test('mensagem de chat não entra no evento', () => {
  const out = permitirEvento(eventoCheio());
  assert.equal(out.extra, undefined);
  assert.equal(out.request.headers, undefined);
  assert.equal(out.request.cookies, undefined);
  assert.equal(out.request.data, undefined);
  assert.equal(out.request.query_string, undefined);
  assert.equal(out.request.url, 'https://api.olumechat.com.br/api/conversas');
  assert.equal(out.request.method, 'POST');
  assert.deepEqual(out.user, { id: 'u:42' });
  assert.equal(out.tags.authorization, undefined);
  assert.equal(out.tags.rota, '/conversas');
  assert.equal(JSON.stringify(out).includes('cardápio'), false);
  assert.equal(JSON.stringify(out).includes('123.456.789-09'), false);
  assert.equal(JSON.stringify(out).includes('Bearer'), false);
});

test('não toca campos de transporte do SDK', () => {
  const entrada = eventoCheio();
  const out = permitirEvento(entrada);
  assert.equal(out.event_id, 'evt-1');
  assert.equal(out.platform, 'node');
  assert.equal(out.sdk, entrada.sdk);
  assert.equal(out.sdk.packages[0].name, 'token-pkg');
  assert.equal(out.exception.values[0].type, 'Error');
  assert.equal(out.exception.values[0].value, REDACAO);
  assert.equal(out.exception.values[0].mechanism.type, 'generic');
  assert.equal(out.exception.values[0].mechanism.data, undefined);
  assert.equal(out.exception.values[0].stacktrace.frames[0].vars, undefined);
  assert.equal(out.exception.values[0].stacktrace.frames[0].context_line, undefined);
  assert.equal(out.exception.values[0].stacktrace.frames[0].filename, 'app.js');
  const http = out.breadcrumbs.find((b) => b.category === 'http');
  assert.equal(http.type, 'http');
  assert.equal(http.category, 'http');
  assert.equal(http.data, undefined);
  assert.equal(http.message, 'https://api.olumechat.com.br/api/stream');
  assert.equal(out.breadcrumbs.some((b) => b.category === 'console'), false);
});

test('breadcrumb de console é descartado', () => {
  assert.equal(permitirBreadcrumb({ category: 'console', type: 'default', message: 'oi' }), null);
});

test('frame, thread, breadcrumb e request perdem query e fragment', () => {
  const out = permitirEvento({
    request: {
      method: 'GET',
      url: 'https://api.olumechat.com.br/api/conversas?ticket=abc#frag',
      query_string: 'ticket=abc',
    },
    exception: {
      values: [{
        type: 'Error',
        value: 'falhou',
        stacktrace: {
          frames: [{
            filename: 'https://olumechat.com.br/assets/index.js?ticket=abc#frag',
            abs_path: 'https://olumechat.com.br/assets/index.js?email=a@b.com#frag',
            function: 'render',
            lineno: 20,
          }, {
            filename: 'file:///app/server/app.js?x=1#L10',
            abs_path: '/app/server/app.js?x=1#L10',
            function: 'boot',
          }, {
            filename: 'webpack://olumechat/./src/App.jsx?x=1',
            abs_path: 'webpack://olumechat/./src/App.jsx?x=1#L2',
          }],
        },
      }],
    },
    threads: {
      values: [{
        stacktrace: {
          frames: [{
            filename: 'https://api.olumechat.com.br/app.js?sid=1#L4',
            abs_path: '/app.js?sid=1#L4',
          }],
        },
      }],
    },
    breadcrumbs: [
      { type: 'http', category: 'http', message: 'https://api.olumechat.com.br/api/stream?ticket=abc#frag' },
      { type: 'navigation', category: 'navigation', message: '/conversas/1?ticket=abc#topo' },
    ],
  });
  const frames = out.exception.values[0].stacktrace.frames;
  assert.equal(frames[0].filename, 'https://olumechat.com.br/assets/index.js');
  assert.equal(frames[0].abs_path, 'https://olumechat.com.br/assets/index.js');
  assert.equal(frames[0].function, 'render');
  assert.equal(frames[0].lineno, 20);
  assert.equal(frames[1].filename, 'file:///app/server/app.js');
  assert.equal(frames[1].abs_path, '/app/server/app.js');
  assert.equal(frames[2].filename, 'webpack://olumechat/./src/App.jsx');
  assert.equal(frames[2].abs_path, 'webpack://olumechat/./src/App.jsx');
  const thread = out.threads.values[0].stacktrace.frames[0];
  assert.equal(thread.filename, 'https://api.olumechat.com.br/app.js');
  assert.equal(thread.abs_path, '/app.js');
  assert.equal(out.request.url, 'https://api.olumechat.com.br/api/conversas');
  assert.equal(out.request.query_string, undefined);
  assert.equal(out.breadcrumbs[0].message, 'https://api.olumechat.com.br/api/stream');
  assert.equal(out.breadcrumbs[1].message, '/conversas/1');
  assert.equal(JSON.stringify(out).includes('ticket'), false);
  assert.equal(JSON.stringify(out).includes('email'), false);
  assert.equal(JSON.stringify(out).includes('#frag'), false);
});

test('release do Sentry usa o commit, não chama versao como função', () => {
  const { derivar, versao } = require('../versao');
  const { releaseAtual } = require('../observabilidade/sentry');
  const sha = '151c565f5093958eddfc42bd981ce0c80951f807';
  const marcador = derivar(sha);
  assert.equal(typeof marcador, 'object');
  assert.equal(typeof marcador.sha, 'string');
  assert.equal(releaseAtual(marcador), sha);
  assert.equal(releaseAtual(derivar('nao-e-sha')), undefined);
  assert.equal(releaseAtual({ sha: null, origem: 'desconhecida' }), undefined);
  assert.equal(releaseAtual(null), undefined);
  const aoVivo = versao && typeof versao.sha === 'string' && versao.sha.length > 0
    ? versao.sha
    : undefined;
  assert.equal(releaseAtual(), aoVivo);
});

test('span tira query e não mexe no id de transporte', () => {
  const span = {
    trace_id: 'abc',
    span_id: 'def',
    parent_span_id: 'ghi',
    start_timestamp: 1,
    end_timestamp: 2,
    status: 'ok',
    is_segment: true,
    name: 'GET https://api.olumechat.com.br/api/midia?token=1',
    attributes: {
      'sentry.op': 'http.server',
      'http.url': 'https://api.olumechat.com.br/api/midia?token=1',
      'http.query': 'token=1',
      'http.request.header.cookie': 'a=b',
      'http.response.status_code': 200,
    },
  };
  const out = limparSpan(span);
  assert.equal(out.trace_id, 'abc');
  assert.equal(out.span_id, 'def');
  assert.equal(out.parent_span_id, 'ghi');
  assert.equal(out.attributes['sentry.op'], 'http.server');
  assert.equal(out.attributes['http.url'], 'https://api.olumechat.com.br/api/midia');
  assert.equal(out.attributes['http.query'], undefined);
  assert.equal(out.attributes['http.request.header.cookie'], undefined);
  assert.equal(out.attributes['http.response.status_code'], 200);
  assert.equal(out.name, 'GET https://api.olumechat.com.br/api/midia');
});

test('payload de WhatsApp na mensagem de erro some por inteiro', () => {
  const out = permitirEvento({
    event_id: 'e',
    exception: { values: [{ type: 'Error', value: '{"wamid":"wamid.1","text":{"body":"oi"}}' }] },
  });
  assert.equal(out.exception.values[0].value, REDACAO);
  assert.equal(out.event_id, 'e');
});

test('sem DSN o sentry da API não inicializa', () => {
  const anterior = process.env.SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  const sentry = require('../observabilidade/sentry');
  assert.equal(sentry.ativo(), false);
  assert.equal(sentry.iniciar(), false);
  assert.doesNotThrow(() => sentry.definirUsuario('u:1'));
  if (anterior === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = anterior;
});

test('paridade com o scrub do client', async () => {
  const client = await import(pathToFileURL());
  const evento = eventoCheio();
  assert.deepEqual(client.permitirEvento(structuredClone(evento)), permitirEvento(structuredClone(evento)));
  const comUrl = {
    request: { url: 'https://olumechat.com.br/login?email=a@b.com#reset' },
    exception: {
      values: [{
        stacktrace: {
          frames: [{
            filename: 'https://olumechat.com.br/assets/index.js?ticket=abc#frag',
            abs_path: '/assets/index.js?ticket=abc#frag',
          }],
        },
      }],
    },
    threads: {
      values: [{
        stacktrace: {
          frames: [{ filename: 'file:///app/server/app.js?x=1#L10', abs_path: 'webpack://olume/./src/App.jsx?x=1' }],
        },
      }],
    },
    breadcrumbs: [{ category: 'navigation', message: '/conversas?ticket=abc#topo' }],
  };
  assert.deepEqual(client.permitirEvento(structuredClone(comUrl)), permitirEvento(structuredClone(comUrl)));
  const span = {
    trace_id: 'abc',
    span_id: 'def',
    start_timestamp: 1,
    status: 'ok',
    is_segment: false,
    name: 'GET /api/conversas?x=1',
    attributes: { 'url.full': 'https://olumechat.com.br/conversas?ticket=a' },
  };
  assert.deepEqual(client.limparSpan(structuredClone(span)), limparSpan(structuredClone(span)));
  assert.equal(client.redigirString('cookie de sessão'), REDACAO);
});

function pathToFileURL() {
  const { pathToFileURL: paraUrl } = require('node:url');
  return paraUrl(path.join(__dirname, '../../client/src/observabilidade/scrub.js')).href;
}
