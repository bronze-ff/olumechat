'use strict';
// FIL-79 — critério de aceite: "nenhuma rota de tenant expõe fatura/pagamento
// — só /api/operador/*" (ver docs/SEGURANCA.md: financeiro vive só no painel
// do operador; o cliente nunca vê fatura, item ou pagamento). Mesmo padrão de
// contrato-nao-vaza-para-tenant.test.js (FIL-76).
//
// Duas checagens complementares:
//  1) NENHUM router de tenant (server/api/*.js) registra uma rota cujo
//     caminho toque "fatura" ou "pagamento" — introspecção real do
//     router.stack, não grep de texto.
//  2) NENHUM arquivo de rota de tenant importa os módulos de negócio do
//     faturamento (server/operador/fatura.js e .../financeiro/faturamento.js).
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

test('nenhum router de rota de tenant (server/api/*.js) registra uma rota de fatura/pagamento', () => {
  assert.ok(ARQUIVOS.length >= 15, `esperava vários arquivos de rota de tenant, achou ${ARQUIVOS.length}`);
  for (const arquivo of ARQUIVOS) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const exportado = require(path.join(API_DIR, arquivo));
    const router = exportado && exportado.router ? exportado.router : exportado;
    const rotas = rotasDoRouter(router);
    for (const { metodo, caminho } of rotas) {
      assert.ok(
        !/fatura|pagamento/i.test(caminho),
        `${arquivo} registra ${metodo} ${caminho} — rota de tenant não pode tocar fatura/pagamento`
      );
    }
  }
});

test('nenhum arquivo de rota de tenant importa os módulos de negócio do faturamento', () => {
  for (const arquivo of ARQUIVOS) {
    const conteudo = fs.readFileSync(path.join(API_DIR, arquivo), 'utf8');
    assert.ok(
      !/operador\/fatura['"]/.test(conteudo) && !/financeiro\/faturamento['"]/.test(conteudo),
      `${arquivo} importa um módulo de faturamento do operador — isso vazaria financeiro para o tenant`
    );
  }
});

test('as rotas de fatura/pagamento só existem sob /api/operador (server/app.js)', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const linhasComFatura = appJs.split('\n').filter((l) => /fatura|pagamento/i.test(l));
  for (const linha of linhasComFatura) {
    assert.ok(/operador|financeiro/i.test(linha), `app.js referencia fatura/pagamento fora do contexto de operador: "${linha.trim()}"`);
  }
});
