'use strict';
// FIL-76 — critério de aceite: "nenhuma rota de tenant expõe contrato/valores
// — só /api/operador/*" (ver docs/SEGURANCA.md: financeiro vive só no painel
// do operador; o cliente nunca vê contrato, nem rota, nem tela).
//
// Duas checagens complementares:
//  1) NENHUM router de tenant (server/api/*.js) registra uma rota cujo
//     caminho toque "contrato" ou "implementacao" — introspecção real do
//     router.stack, não grep de texto (mesmo padrão de
//     operador-acesso.test.js::rotasDoOperador).
//  2) NENHUM arquivo de rota de tenant importa os módulos de negócio do
//     contrato (server/operador/contrato.js e .../implementacao.js) — um
//     import desses módulos ali seria o primeiro sinal de vazamento.
process.env.META_APP_SECRET = 'x'; process.env.WEBHOOK_VERIFY_TOKEN = 'x'; process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = 'x'; process.env.WA_BUSINESS_ACCOUNT_ID = 'x';
process.env.JWT_SECRET = 'seg-teste-32-chars-abcdefghijk';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const API_DIR = path.join(__dirname, '..', 'api');
const ARQUIVOS = fs.readdirSync(API_DIR).filter((f) => f.endsWith('.js'));

function rotasDoRouter(router) {
  if (!router || !router.stack) return [];
  return router.stack
    .filter((camada) => camada.route)
    .flatMap((camada) => Object.keys(camada.route.methods)
      .filter((m) => m !== '_all')
      .map((metodo) => ({ metodo: metodo.toUpperCase(), caminho: camada.route.path })));
}

test('nenhum router de rota de tenant (server/api/*.js) registra uma rota de contrato/implementação', () => {
  assert.ok(ARQUIVOS.length >= 15, `esperava vários arquivos de rota de tenant, achou ${ARQUIVOS.length}`);
  for (const arquivo of ARQUIVOS) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const exportado = require(path.join(API_DIR, arquivo));
    const router = exportado && exportado.router ? exportado.router : exportado;
    const rotas = rotasDoRouter(router);
    for (const { metodo, caminho } of rotas) {
      assert.ok(
        !/contrato|implementacao/i.test(caminho),
        `${arquivo} registra ${metodo} ${caminho} — rota de tenant não pode tocar contrato/implementação`
      );
    }
  }
});

test('nenhum arquivo de rota de tenant importa os módulos de negócio do contrato', () => {
  for (const arquivo of ARQUIVOS) {
    const conteudo = fs.readFileSync(path.join(API_DIR, arquivo), 'utf8');
    assert.ok(
      !/operador\/contrato['"]/.test(conteudo) && !/operador\/implementacao['"]/.test(conteudo),
      `${arquivo} importa um módulo de contrato/implementação do operador — isso vazaria financeiro para o tenant`
    );
  }
});

test('as rotas de contrato/implementação só existem sob /api/operador (server/app.js)', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const linhasComContrato = appJs.split('\n').filter((l) => /contrato|implementacao/i.test(l));
  for (const linha of linhasComContrato) {
    assert.ok(/operador/i.test(linha), `app.js referencia contrato/implementação fora do contexto de operador: "${linha.trim()}"`);
  }
});
