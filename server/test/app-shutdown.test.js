// Testes do shutdown gracioso em SIGTERM (server/app.js) — FIL-93 (P0.7):
// "encerra timers, workers e conexões SSE com prazo máximo (ex.: 10s) e sai
// limpo". app.js não é require()ável em isolamento sem efeito colateral
// pesado (abre pool real, monta toda a árvore de rotas) — igual aos outros
// testes que auditam app.js por texto (ver test/contrato-nao-vaza-para-
// tenant.test.js), a prova aqui é de que o código do shutdown() faz as
// coisas certas, na ordem certa; o comportamento unitário de cada peça
// (encerrarTodas() do SSE, parar() dos workers) já tem teste próprio.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function corpoDaFuncao(nome) {
  const inicio = APP_JS.indexOf(`function ${nome}(`);
  assert.ok(inicio >= 0, `app.js deveria declarar function ${nome}(...)`);
  // Cada shutdown/start é fechado por um "process.on" ou "start();" logo
  // depois — corta ali para não pegar o resto do arquivo.
  const fimAprox = APP_JS.indexOf('\nstart();', inicio);
  return APP_JS.slice(inicio, fimAprox >= 0 ? fimAprox : undefined);
}

test('shutdown() encerra as conexões SSE abertas (senão server.close() nunca chama o callback)', () => {
  const corpo = corpoDaFuncao('shutdown');
  assert.match(corpo, /require\(['"]\.\/api\/stream['"]\)\.encerrarTodas\(\)/);
});

test('shutdown() para os workers com timer periódico (sweeper, campanha, consumo, faturamento, pulso)', () => {
  const corpo = corpoDaFuncao('shutdown');
  for (const modulo of ['./bot/sweeper', './campanha/dispatcher', './consumo/fechamento', './financeiro/faturamento']) {
    assert.match(
      corpo,
      new RegExp(`require\\(['"]${modulo.replace('/', '\\/')}['"]\\)\\.parar\\(\\)`),
      `shutdown() deveria chamar require('${modulo}').parar()`
    );
  }
  assert.match(corpo, /pulso\??\.parar\(\)/, 'shutdown() deveria parar o agente de telemetria (pulso)');
});

test('shutdown() tem um prazo máximo que força a saída se o encerramento gracioso travar', () => {
  const corpo = corpoDaFuncao('shutdown');
  assert.match(corpo, /setTimeout\(/, 'shutdown() deveria armar um timer de prazo máximo');
  assert.match(corpo, /process\.exit\(1\)/, 'o estouro do prazo deveria forçar saída com código de erro (1), não travar');
});

test('shutdown() ainda encerra hub e pool no caminho feliz (sem regredir o que já existia)', () => {
  const corpo = corpoDaFuncao('shutdown');
  assert.match(corpo, /await hub\.stop\(\)/);
  assert.match(corpo, /await db\.closePool\(\)/);
  assert.match(corpo, /process\.exit\(0\)/);
});

test('o agente de telemetria (pulso) é capturado numa variável no start() — não dá pra chamar .parar() num require() novo sem vazar o timer antigo', () => {
  const corpo = corpoDaFuncao('start');
  assert.match(
    corpo,
    /const pulso\s*=\s*require\(['"]\.\/telemetria\/pulso-agent['"]\)\.iniciar\(/,
    'start() deveria capturar o retorno de pulso-agent.iniciar() (ele tem estado próprio de módulo — chamar iniciar() de novo no shutdown criaria um 2º timer)'
  );
});
