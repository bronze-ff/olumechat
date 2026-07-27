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
const hub = require('../realtime/hub');

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

test('tenant: todo evento publicado no hub carrega o tenantId da campanha (SSE não pode vazar entre tenants)', async () => {
  const eventos = [];
  const cancelar = hub.subscribe((e) => eventos.push(e));
  try {
    const conn = fakeConn({ campanha: { ...CAMP }, itens: [{ ...ITEM }] });
    await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => ({ messages: [{ id: 'x' }] }) }));
  } finally { cancelar(); }
  assert.ok(eventos.length > 0, 'nenhum evento publicado');
  assert.ok(eventos.every((e) => e.tenantId === TENANT), 'evento de campanha publicado sem tenantId (ou com tenant errado)');
});

test('tenant: evento de pausa (limite diário) também carrega o tenantId', async () => {
  const eventos = [];
  const cancelar = hub.subscribe((e) => eventos.push(e));
  try {
    const conn = fakeConn({ campanha: { ...CAMP, LIMITE_DIARIO: 250 }, usados: 250, itens: [{ ...ITEM }] });
    await dispatcher.processarLote(TENANT, 1, deps({ conn, sendTemplate: async () => ({ messages: [{ id: 'x' }] }) }));
  } finally { cancelar(); }
  assert.ok(eventos.some((e) => e.status === 'pausada'));
  assert.ok(eventos.every((e) => e.tenantId === TENANT), 'evento de pausa publicado sem tenantId (ou com tenant errado)');
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
      assert.match(sql, /JOIN tenant t ON t\.ID = c\.TENANT_ID/);
      assert.match(sql, /t\.STATUS = 'ativo'/);
      return { rows: [{ ID: 10, TENANT_ID: 1 }, { ID: 20, TENANT_ID: 2 }] };
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

test('tick: campanha de tenant suspenso/encerrado NÃO é agendada (o JOIN com tenant já filtra no banco)', async () => {
  const tenantsChamados = [];
  const conn = fakeConn({ campanha: { ...CAMP }, itens: [] });
  // Simula o filtro `t.STATUS = 'ativo'` do JOIN real: a linha do tenant 2
  // (suspenso) nunca chega a sair do banco — o dispatcher não precisa (nem
  // deveria) filtrar de novo em JS.
  const TODAS = [{ ID: 10, TENANT_ID: 1 }, { ID: 20, TENANT_ID: 2 }];
  const STATUS_TENANT = { 1: 'ativo', 2: 'suspenso' };
  const rawConn = {
    async execute(sql) {
      assert.match(sql, /t\.STATUS = 'ativo'/);
      return { rows: TODAS.filter((c) => STATUS_TENANT[c.TENANT_ID] === 'ativo') };
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
  assert.deepEqual(tenantsChamados, [1], 'campanha do tenant suspenso (2) não deveria ter sido agendada');
});

test('FIL-73: dois ticks concorrentes enviam cada item uma única vez', async () => {
  let lockOcupado = false;
  let pendente = true;
  let envios = 0;
  const conn = {
    async execute(sql) {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        if (lockOcupado) return { rows: [{ ADQUIRIDO: false }] };
        lockOcupado = true;
        return { rows: [{ ADQUIRIDO: true }] };
      }
      if (sql.includes('FROM campanha c')) return { rows: [{ ...CAMP }] };
      if (sql.includes("ci.ENVIADO_EM >= date_trunc('day', now())")) return { rows: [{ QTD: 0 }] };
      if (sql.includes("STATUS = 'pendente'") && sql.includes('SELECT ID, TELEFONE')) {
        return { rows: pendente ? [{ ...ITEM }] : [] };
      }
      if (sql.includes("SET STATUS = 'enviando_item'")) {
        if (!pendente) return { rowsAffected: 0 };
        pendente = false;
        return { rowsAffected: 1 };
      }
      if (sql.includes('FROM auditoria')) return { rows: [] };
      return { rows: [], rowsAffected: 1, outBinds: {} };
    },
    commit: async () => { lockOcupado = false; },
    rollback: async () => { lockOcupado = false; },
    close: async () => {},
  };
  const raw = { execute: async () => ({ rows: [{ ID: 1, TENANT_ID: TENANT }] }), close: async () => {} };
  const d = {
    getConnection: async () => raw,
    comTenant: async (_tenantId, fn) => {
      try { const result = await fn(conn); await conn.commit(); return result; }
      catch (err) { await conn.rollback(); throw err; }
    },
    sendTemplate: async () => { envios++; return { messages: [{ id: 'wamid.once' }] }; },
    agora: AGORA,
  };

  await Promise.all([dispatcher.tick(d), dispatcher.tick(d)]);
  assert.equal(envios, 1);
});

test('FIL-73: lock perdido encerra o tick silenciosamente', async () => {
  let erros = 0;
  const conn = {
    async execute(sql) {
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ ADQUIRIDO: false }] };
      erros++;
      return { rows: [{ ...CAMP }] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const d = {
    comTenant: async (_tenantId, fn) => fn(conn),
    sendTemplate: async () => { throw new Error('nao deveria enviar'); },
    agora: AGORA,
  };
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try { await dispatcher.processarLote(TENANT, 1, d); }
  finally { console.error = originalError; }
  assert.equal(erros, 0);
  assert.deepEqual(logs, []);
});

test('FIL-73: tenants diferentes adquirem locks independentes', async () => {
  let ativos = 0;
  let maxAtivos = 0;
  const chaves = [];
  const conn = {
    async execute(sql, binds = {}) {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        chaves.push(binds.chave);
        return { rows: [{ ADQUIRIDO: true }] };
      }
      if (sql.includes('FROM campanha c')) return { rows: [{ ...CAMP, LIMITE_DIARIO: null }] };
      if (sql.includes("STATUS = 'pendente'") && sql.includes('SELECT ID, TELEFONE')) return { rows: [] };
      return { rows: [], rowsAffected: 1, outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  const raw = {
    execute: async () => ({ rows: [{ ID: 1, TENANT_ID: 1 }, { ID: 2, TENANT_ID: 2 }] }),
    close: async () => {},
  };
  const d = {
    getConnection: async () => raw,
    comTenant: async (_tenantId, fn) => {
      ativos++;
      maxAtivos = Math.max(maxAtivos, ativos);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try { return await fn(conn); } finally { ativos--; }
    },
    agora: AGORA,
  };
  await dispatcher.tick(d);
  assert.equal(maxAtivos, 2, 'tenant A e tenant B deveriam executar simultaneamente');
  assert.notEqual(chaves[0], chaves[1], 'cada tenant deve ter uma chave de lock distinta');
});

test('FIL-73: lock transacional fica disponível depois de falha no ciclo', async () => {
  let ocupado = false;
  let falhar = true;
  const conn = {
    async execute(sql) {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        if (ocupado) return { rows: [{ ADQUIRIDO: false }] };
        ocupado = true;
        return { rows: [{ ADQUIRIDO: true }] };
      }
      if (falhar && sql.includes('FROM campanha c')) throw new Error('falha no ciclo');
      return { rows: [], rowsAffected: 1, outBinds: {} };
    },
    commit: async () => { ocupado = false; },
    rollback: async () => { ocupado = false; },
    close: async () => {},
  };
  const d = {
    comTenant: async (_tenantId, fn) => {
      try { const result = await fn(conn); await conn.commit(); return result; }
      catch (err) { await conn.rollback(); throw err; }
    },
    agora: AGORA,
  };
  await assert.rejects(dispatcher.processarLote(TENANT, 1, d), /falha no ciclo/);
  falhar = false;
  await assert.doesNotReject(dispatcher.processarLote(TENANT, 1, d));
  assert.equal(ocupado, false);
});
