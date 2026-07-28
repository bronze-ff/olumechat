'use strict';
// FIL-80 — critério de aceite: o painel financeiro (MRR, a receber, margem
// por cliente) não pode ser alcançado por rota de tenant nem de suporte (ver
// docs/SEGURANCA.md). Mesmo padrão de fatura-nao-vaza-para-tenant.test.js
// (FIL-79) e contrato-nao-vaza-para-tenant.test.js (FIL-76): introspecção real
// do router de cada arquivo de rota de tenant, mais varredura estática de
// import — nunca confiar só em "a UI não mostra o link".
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

test('nenhum router de rota de tenant (server/api/*.js) registra uma rota de financeiro', () => {
  assert.ok(ARQUIVOS.length >= 15, `esperava vários arquivos de rota de tenant, achou ${ARQUIVOS.length}`);
  for (const arquivo of ARQUIVOS) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const exportado = require(path.join(API_DIR, arquivo));
    const router = exportado && exportado.router ? exportado.router : exportado;
    const rotas = rotasDoRouter(router);
    for (const { metodo, caminho } of rotas) {
      assert.ok(
        !/financeiro/i.test(caminho),
        `${arquivo} registra ${metodo} ${caminho} — rota de tenant não pode tocar o painel financeiro`
      );
    }
  }
});

test('nenhum arquivo de rota de tenant importa o módulo do painel financeiro', () => {
  for (const arquivo of ARQUIVOS) {
    const conteudo = fs.readFileSync(path.join(API_DIR, arquivo), 'utf8');
    assert.ok(
      !/financeiro\/painel['"]/.test(conteudo),
      `${arquivo} importa financeiro/painel — isso vazaria MRR/margem para o tenant`
    );
  }
});

test('a rota /api/operador/financeiro só é montada dentro do router do operador (server/app.js)', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const linhasDeRota = appJs.split('\n').filter((l) => /app\.use\(.*financeiro/i.test(l));
  assert.equal(linhasDeRota.length, 0, 'nenhuma rota de "/financeiro" deve ser montada fora de /api/operador/*');
});
