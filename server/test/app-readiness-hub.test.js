// Testes de que app.js liga o estado do hub SSE/LISTEN-NOTIFY ao boot e ao
// /health/ready — FIL-93 (P0.7). app.js tem efeito colateral pesado ao ser
// `require`ado (abre pool, monta rotas reais) — os demais testes do repo
// evitam requerê-lo diretamente por isso (ver test/contrato-nao-vaza-para-
// tenant.test.js, que também faz varredura de texto em vez de subir o app
// inteiro). Aqui seguimos o mesmo padrão: prova por leitura de código que (1)
// o boot aguarda hub.start() antes de escutar a porta e (2) a rota de
// readiness inclui o estado do hub — sem inventar dependência de R2 nela.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('start() aguarda hub.start() antes de abrir a porta (readiness não fica "ok" antes do hub tentar subir)', () => {
  const idxHubStart = APP_JS.indexOf('hub.start()');
  const idxListen = APP_JS.indexOf('app.listen(');
  assert.ok(idxHubStart >= 0, 'app.js deveria chamar hub.start()');
  assert.ok(idxListen >= 0, 'app.js deveria chamar app.listen()');
  assert.ok(idxHubStart < idxListen, 'hub.start() deveria ser chamado (e aguardado) antes de app.listen()');
  assert.match(APP_JS, /await hub\.start\(\)/, 'hub.start() precisa ser aguardado (await), não fire-and-forget');
});

test('a função readiness reporta o estado do hub, sem checar R2/storage', () => {
  const inicio = APP_JS.indexOf('async function readiness');
  const fim = APP_JS.indexOf('\n}', inicio);
  const corpo = APP_JS.slice(inicio, fim);
  assert.match(corpo, /hub\.status\(\)/, 'readiness deveria reportar hub.status()');
  assert.doesNotMatch(corpo, /storage|r2|s3/i, 'readiness não deve inventar dependência de storage/R2 (P0.7)');
});
