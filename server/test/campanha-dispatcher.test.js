// Testes do dispatcher de campanha: throttle/lote, corrida (claim), opt-out,
// rate-limit (backoff), erro definitivo, idempotência no restart.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');
const dispatcher = require('../campanha/dispatcher');

// Hora fixa dentro da janela 08:00-20:00.
const AGORA = () => new Date(2026, 5, 11, 12, 0, 0);
const TENANT = 99; // arbitrário — o fake conn não filtra por tenant, só grava quem chamou.

// Mock de conexão configurável. `itens` é consumido uma vez (2º lote vazio →
// campanha conclui, encerrando a auto-recursão do acordar).
function fakeConn({ campanha, usados = 0, itens = [], optout = false, claimOk = true, capturas = [] }) {
  let loteServido = false;
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM campanha c')) return { rows: [campanha] };
      if (sql.includes("ci.ENVIADO_EM >= date_trunc('day', now())")) return { rows: [{ QTD: usados }] };
      if (sql.includes("STATUS = 'pendente'") && sql.includes('SELECT ID, TELEFONE')) {
        if (loteServido) return { rows: [] };
        loteServido = true;
        return { rows: itens };
      }
      if (sql.includes("SET STATUS = 'enviando_item'")) return { rowsAffected: claimOk ? 1 : 0 };
      if (sql.includes('FROM auditoria')) return { rows: optout ? [{ ACAO: 'optout' }] : [] };
      return { rows: [], rowsAffected: 1, outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

const CAMP = {
  STATUS: 'enviando', TEMPLATE_NOME: 'lembrete_pagamento', LANG: 'pt_BR', RATE_POR_SEG: 100,
  JANELA_INICIO: '08:00', JANELA_FIM: '20:00', RETOMA_EM: null,
  NUMERO_ID: 2, PHONE_NUMBER_ID: '1112223334', LIMITE_DIARIO: 250,
};
// VARIAVEIS já chega parseada (jsonb) — o driver pg não devolve mais string.
const ITEM = { ID: 10, TELEFONE: '5562999990000', VARIAVEIS: ['Fulano', '150,00'], CONTATO_ID: null };

// `comTenant` mockado roda fn(conn) direto (sem BEGIN/COMMIT real — o contrato
// do comTenant() em si já tem prova própria em db-tenant.test.js). O MESMO
// conn é reusado em toda chamada (setup + cada item + a recursão do acordar).
function deps({ conn, sendTemplate }) {
  return {
    getConnection: async () => conn,
    comTenant: async (tenantId, fn) => {
      try { const r = await fn(conn); await conn.commit(); return r; }
      catch (e) { await conn.rollback(); throw e; }
    },
    sendTemplate, agora: AGORA,
  };
}

test('envio OK: claim → sendTemplate → STATUS=enviado + WAMID + ENVIADOS++', async () => {
  const capturas = [];
  const conn = fakeConn({ campanha: { ...CAMP }, itens: [{ ...ITEM }], capturas });
  let enviado;
  const sendTemplate = async (to, nome, lang, vars) => { enviado = { to, nome, lang, vars }; return { messages: [{ id: 'wamid.C1' }] }; };
  await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate }));

  assert.equal(enviado.to, '5562999990000');
  assert.equal(enviado.nome, 'lembrete_pagamento');
  assert.deepEqual(enviado.vars, ['Fulano', '150,00']);
  const updOk = capturas.find((c) => c.sql.includes("SET STATUS = 'enviado'"));
  assert.equal(updOk.binds.w, 'wamid.C1');
  assert.ok(capturas.some((c) => c.sql.includes('ENVIADOS = ENVIADOS + 1')));
});

test('throttle: o lote pede no máximo RATE_POR_SEG itens', async () => {
  const capturas = [];
  const conn = fakeConn({ campanha: { ...CAMP, RATE_POR_SEG: 5 }, itens: [], capturas });
  await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => ({ messages: [{ id: 'x' }] }) }));
  const lote = capturas.find((c) => c.sql.includes('SELECT ID, TELEFONE'));
  assert.equal(lote.binds.n, 5);
});

test('corrida: claim rowsAffected=0 → não envia', async () => {
  const conn = fakeConn({ campanha: { ...CAMP }, itens: [{ ...ITEM }], claimOk: false });
  let chamou = false;
  await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => { chamou = true; return { messages: [{ id: 'x' }] }; } }));
  assert.equal(chamou, false);
});

test('opt-out no disparo: marca optout e NÃO envia', async () => {
  const capturas = [];
  const conn = fakeConn({ campanha: { ...CAMP }, itens: [{ ...ITEM }], optout: true, capturas });
  let chamou = false;
  await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => { chamou = true; return { messages: [{ id: 'x' }] }; } }));
  assert.equal(chamou, false);
  assert.ok(capturas.some((c) => c.sql.includes("SET STATUS = 'optout'")));
});

test('rate-limit (131049): item volta a pendente e campanha pausa (sem falha)', async () => {
  const capturas = [];
  const conn = fakeConn({ campanha: { ...CAMP }, itens: [{ ...ITEM }], capturas });
  const erro = Object.assign(new Error('rate'), { isGraphError: true, graphCode: 131049 });
  await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => { throw erro; } }));
  assert.ok(capturas.some((c) => c.sql.includes("SET STATUS = 'pendente'") && c.sql.includes('campanha_item')));
  assert.ok(capturas.some((c) => c.sql.includes("SET STATUS = 'pausada'")));
  assert.equal(capturas.some((c) => c.sql.includes("SET STATUS = 'falha'")), false);
});

test('erro definitivo (132001): item vira falha e o lote continua', async () => {
  const capturas = [];
  const conn = fakeConn({ campanha: { ...CAMP }, itens: [{ ...ITEM }], capturas });
  const erro = Object.assign(new Error('template'), { isGraphError: true, graphCode: 132001 });
  await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => { throw erro; } }));
  const falha = capturas.find((c) => c.sql.includes("SET STATUS = 'falha'"));
  assert.ok(falha);
  assert.equal(falha.binds.e, '132001');
  assert.equal(capturas.some((c) => c.sql.includes("SET STATUS = 'pausada'")), false);
});

test('limite diário atingido → pausa sem enviar', async () => {
  const capturas = [];
  const conn = fakeConn({ campanha: { ...CAMP, LIMITE_DIARIO: 250 }, usados: 250, itens: [{ ...ITEM }], capturas });
  let chamou = false;
  await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => { chamou = true; return { messages: [{ id: 'x' }] }; } }));
  assert.equal(chamou, false);
  assert.ok(capturas.some((c) => c.sql.includes("SET STATUS = 'pausada'") && c.binds.m.includes('limite diário')));
});

test('fora da janela de horário → não envia', async () => {
  const conn = fakeConn({ campanha: { ...CAMP, JANELA_INICIO: '08:00', JANELA_FIM: '09:00' }, itens: [{ ...ITEM }] });
  let chamou = false;
  // AGORA = 12:00, fora de 08:00-09:00
  await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => { chamou = true; return { messages: [{ id: 'x' }] }; } }));
  assert.equal(chamou, false);
});

test('dentroDaJanela: respeita HH:MM', () => {
  assert.equal(dispatcher.dentroDaJanela(new Date(2026, 5, 11, 12, 0), '08:00', '20:00'), true);
  assert.equal(dispatcher.dentroDaJanela(new Date(2026, 5, 11, 7, 0), '08:00', '20:00'), false);
  assert.equal(dispatcher.dentroDaJanela(new Date(2026, 5, 11, 21, 0), '08:00', '20:00'), false);
});

test('tenant: processarItem roda dentro de comTenant(tenantId, ...) com o tenant da campanha', async () => {
  const capturasTenant = [];
  const conn = fakeConn({ campanha: { ...CAMP }, itens: [{ ...ITEM }] });
  const d = deps({ conn, sendTemplate: async () => ({ messages: [{ id: 'x' }] }) });
  const comTenantOriginal = d.comTenant;
  d.comTenant = async (tenantId, fn) => { capturasTenant.push(tenantId); return comTenantOriginal(tenantId, fn); };
  await dispatcher.processarLote(TENANT, 1, d);
  assert.ok(capturasTenant.length > 0);
  assert.ok(capturasTenant.every((t) => t === TENANT), 'alguma chamada usou um tenantId diferente do da campanha');
});

test('varrerPendentes: itera os tenants ativos e roda a limpeza dentro de comTenant() de cada um', async () => {
  const tenantsChamados = [];
  const rawConn = {
    async execute(sql) {
      if (sql.includes("FROM tenant WHERE STATUS = 'ativo'")) return { rows: [{ ID: 1 }, { ID: 2 }] };
      return { rows: [] };
    },
    close: async () => {},
  };
  const d = {
    getConnection: async () => rawConn,
    comTenant: async (tenantId, fn) => { tenantsChamados.push(tenantId); return fn({ execute: async () => ({ rows: [] }) }); },
  };
  await dispatcher.varrerPendentes(d);
  assert.deepEqual(tenantsChamados, [1, 2]);
});

test('tick: descobre campanhas enviando cruzando tenants (leitura crua) e processa cada uma com o tenant da linha', async () => {
  const tenantsChamados = [];
  // Sem itens pendentes → cada campanha conclui de imediato (sem recursão).
  const conn = fakeConn({ campanha: { ...CAMP }, itens: [] });
  const rawConn = {
    async execute(sql) {
      if (sql.includes('SELECT ID, TENANT_ID FROM campanha')) {
        return { rows: [{ ID: 10, TENANT_ID: 1 }, { ID: 20, TENANT_ID: 2 }] };
      }
      return { rows: [] };
    },
    close: async () => {},
  };
  const d = {
    getConnection: async () => rawConn,
    comTenant: async (tenantId, fn) => { tenantsChamados.push(tenantId); return fn(conn); },
    sendTemplate: async () => ({ messages: [{ id: 'x' }] }),
    agora: AGORA,
  };
  await dispatcher.tick(d);
  assert.deepEqual(tenantsChamados.sort(), [1, 2]);
});
