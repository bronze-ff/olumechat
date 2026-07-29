'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
// FIL-85 — rotas de configuração das ferramentas da IA e do formulário de pedido.
//
// Pontos que estes testes seguram:
//  - papel errado não lê nem escreve (SEGURANCA.md §3: autorização no backend);
//  - tudo atrás do add-on (tenant.ia_habilitada), não só escondido na UI;
//  - toda escrita AUDITA e INVALIDA o cache de 60s (senão o admin liga o
//    recurso e a IA continua sem ele por um minuto);
//  - `transferir_para_humano` não é configurável — não pode virar linha no banco.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');
const ferramentasStore = require('../ia/ferramentasStore');

const rotas = require('../api/iaFerramentas');

const TENANT = 93001;

function servidor(papel = 'ADMIN', tenantId = TENANT) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { matricula: 10, tenantId }; req.perfil = { atendenteId: 1, papel }; req.tenantId = tenantId; next();
  });
  app.use('/api/ia-ferramentas', rotas);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

function req(app, metodo, caminho, corpo) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const dados = corpo === undefined ? null : JSON.stringify(corpo);
      const r = http.request({
        port: srv.address().port, path: caminho, method: metodo,
        headers: { 'content-type': 'application/json', ...(dados ? { 'content-length': Buffer.byteLength(dados) } : {}) },
      }, (res) => {
        let d = ''; res.on('data', (c) => (d += c));
        res.on('end', () => { srv.close(); let body = null; try { body = d ? JSON.parse(d) : null; } catch { /* não-JSON */ }
          resolve({ status: res.statusCode, body }); });
      });
      if (dados) r.write(dados);
      r.end();
    });
  });
}

/** Banco falso. `estado` guarda o que foi escrito para as asserções. */
function banco({ iaHabilitada = 'S', ferramentas = [], template = null, erro = null } = {}) {
  const estado = { escritas: [], auditoria: [] };
  db.getConnection = async () => ({
    async execute(sql, b = {}) {
      if (/^(SET|SELECT set_config|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql)) return { rows: [] };
      if (sql.includes('SELECT ia_habilitada')) return { rows: [{ IA_HABILITADA: iaHabilitada }] };
      if (erro) throw erro;
      // Só as LEITURAS entram aqui: o DELETE do template também casa com
      // "FROM ia_pedido_template" e precisa cair nas escritas.
      const ehSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
      if (ehSelect && sql.includes('FROM ia_ferramenta')) return { rows: ferramentas };
      if (ehSelect && sql.includes('FROM ia_pedido_template')) return { rows: template ? [template] : [] };
      if (sql.includes('INSERT INTO auditoria')) { estado.auditoria.push(b); return { rows: [] }; }
      estado.escritas.push({ sql, binds: b });
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  });
  return estado;
}

const TEMPLATE_OK = {
  titulo: 'Pedido de delivery',
  campos: [
    { rotulo: 'Sabor', tipo: 'opcoes', opcoes: ['Calabresa', 'Marguerita'], obrigatorio: true },
    { rotulo: 'Quantidade', tipo: 'numero' },
  ],
};

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
test('GET devolve o catálogo com os defaults do código quando não há linha no banco', async () => {
  banco();
  const r = await req(servidor('ADMIN'), 'GET', '/api/ia-ferramentas');
  assert.equal(r.status, 200);
  const porNome = Object.fromEntries(r.body.ferramentas.map((f) => [f.nome, f]));
  assert.equal(porNome.atualizar_ficha_contato.ativo, true);
  assert.equal(porNome.aplicar_tag.ativo, true);
  assert.equal(porNome.registrar_pedido.ativo, false, 'pedido nasce desligado (spec)');
  assert.equal(porNome.registrar_pedido.exigeTemplate, true, 'a tela precisa avisar que sem formulário não funciona');
  assert.equal(r.body.template, null);
  assert.ok(r.body.limites.campos > 0 && r.body.tipos.includes('opcoes'));
});

test('GET reflete o que está salvo e devolve o template', async () => {
  banco({
    ferramentas: [{ NOME: 'aplicar_tag', ATIVO: 'N' }],
    template: { TITULO: 'Pedido', CAMPOS: [{ nome: 'sabor', rotulo: 'Sabor', tipo: 'texto' }], ATUALIZADO_EM: null },
  });
  const r = await req(servidor('SUPERVISOR'), 'GET', '/api/ia-ferramentas');
  const porNome = Object.fromEntries(r.body.ferramentas.map((f) => [f.nome, f]));
  assert.equal(porNome.aplicar_tag.ativo, false);
  assert.equal(r.body.template.titulo, 'Pedido');
  assert.equal(r.body.template.campos.length, 1);
});

test('transferir_para_humano NÃO é configurável (desligar a saída prenderia o cliente com o robô)', async () => {
  banco();
  const r = await req(servidor('ADMIN'), 'GET', '/api/ia-ferramentas');
  assert.ok(!r.body.ferramentas.some((f) => f.nome === 'transferir_para_humano'));
  const put = await req(servidor('ADMIN'), 'PUT', '/api/ia-ferramentas/transferir_para_humano', { ativo: false });
  assert.equal(put.status, 404);
});

test('migração 022 pendente: a tela abre com os defaults em vez de 500', async () => {
  const err = new Error('relation "ia_ferramenta" does not exist'); err.code = '42P01';
  banco({ erro: err });
  const r = await req(servidor('ADMIN'), 'GET', '/api/ia-ferramentas');
  assert.equal(r.status, 200);
  assert.equal(r.body.template, null);
  assert.equal(r.body.ferramentas.length, 3);
});

// ---------------------------------------------------------------------------
// Papéis e add-on
// ---------------------------------------------------------------------------
test('add-on desligado: nem leitura nem escrita (server-side, não só na UI)', async () => {
  banco({ iaHabilitada: 'N' });
  assert.equal((await req(servidor('ADMIN'), 'GET', '/api/ia-ferramentas')).status, 400);
  assert.equal((await req(servidor('ADMIN'), 'PUT', '/api/ia-ferramentas/aplicar_tag', { ativo: true })).status, 400);
  assert.equal((await req(servidor('ADMIN'), 'PUT', '/api/ia-ferramentas/template', TEMPLATE_OK)).status, 400);
});

test('ATENDENTE não lê a configuração; AUDITOR lê mas não escreve', async () => {
  banco();
  assert.equal((await req(servidor('ATENDENTE'), 'GET', '/api/ia-ferramentas')).status, 403);
  assert.equal((await req(servidor('AUDITOR'), 'GET', '/api/ia-ferramentas')).status, 200);
  assert.equal((await req(servidor('AUDITOR'), 'PUT', '/api/ia-ferramentas/aplicar_tag', { ativo: false })).status, 403);
  assert.equal((await req(servidor('SUPERVISOR'), 'PUT', '/api/ia-ferramentas/template', TEMPLATE_OK)).status, 403);
});

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------
test('PUT /:nome liga a ferramenta, audita e invalida o cache do runtime', async () => {
  const estado = banco();
  let invalidado = null;
  const original = ferramentasStore.invalidar;
  ferramentasStore.invalidar = (t) => { invalidado = t; };
  try {
    const r = await req(servidor('ADMIN'), 'PUT', '/api/ia-ferramentas/registrar_pedido', { ativo: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ativo, true);
    const ins = estado.escritas.find((e) => /INSERT INTO ia_ferramenta/i.test(e.sql));
    assert.equal(ins.binds.ativo, 'S');
    assert.equal(ins.binds.nome, 'registrar_pedido');
    assert.equal(ins.binds.tenantId, TENANT);
    assert.match(ins.sql, /ON CONFLICT \(tenant_id, nome\) DO UPDATE/i, 'ligar/desligar não pode duplicar linha');
    assert.equal(estado.auditoria.length, 1);
    assert.equal(invalidado, TENANT);
  } finally { ferramentasStore.invalidar = original; }
});

test('PUT /:nome com nome fora do catálogo é 404 (lista branca, não texto livre)', async () => {
  banco();
  const r = await req(servidor('ADMIN'), 'PUT', '/api/ia-ferramentas/apagar_banco', { ativo: true });
  assert.equal(r.status, 404);
});

test('PUT /template valida antes de gravar e normaliza os campos', async () => {
  const estado = banco();
  const r = await req(servidor('ADMIN'), 'PUT', '/api/ia-ferramentas/template', TEMPLATE_OK);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.template.campos.map((c) => c.nome), ['sabor', 'quantidade']);
  const ins = estado.escritas.find((e) => /INSERT INTO ia_pedido_template/i.test(e.sql));
  const campos = JSON.parse(ins.binds.campos);
  assert.equal(campos[0].obrigatorio, true);
  assert.deepEqual(campos[0].opcoes, ['Calabresa', 'Marguerita']);
  assert.equal(estado.auditoria.length, 1);
});

test('PUT /template rejeita formulário inválido com mensagem de tela', async () => {
  banco();
  const semTitulo = await req(servidor('ADMIN'), 'PUT', '/api/ia-ferramentas/template', { campos: [{ rotulo: 'x' }] });
  assert.equal(semTitulo.status, 400);
  assert.match(semTitulo.body.error, /título/i);
  const semCampos = await req(servidor('ADMIN'), 'PUT', '/api/ia-ferramentas/template', { titulo: 'P', campos: [] });
  assert.equal(semCampos.status, 400);
});

test('DELETE /template remove o formulário (a ferramenta deixa de ser oferecida)', async () => {
  const estado = banco();
  const r = await req(servidor('ADMIN'), 'DELETE', '/api/ia-ferramentas/template');
  assert.equal(r.status, 200);
  assert.ok(estado.escritas.some((e) => /DELETE FROM ia_pedido_template/i.test(e.sql)));
  assert.ok(!estado.escritas.some((e) => /DELETE FROM ia_pedido\b/i.test(e.sql)),
    'pedido já registrado guarda a própria cópia dos rótulos — não pode ser apagado junto');
});

test('SEGURANÇA: toda escrita leva o tenant_id do chamador', async () => {
  const estado = banco();
  const app = servidor('ADMIN', 777);
  await req(app, 'PUT', '/api/ia-ferramentas/aplicar_tag', { ativo: false });
  await req(app, 'PUT', '/api/ia-ferramentas/template', TEMPLATE_OK);
  assert.ok(estado.escritas.every((e) => e.binds.tenantId === 777));
  assert.ok(estado.auditoria.every((a) => a.tenantId === 777));
});
