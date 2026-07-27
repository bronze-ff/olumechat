// Testes da presença (refcount/graça/pausa) e do distribuidor (least-loaded).
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const presence = require('../realtime/presence');
const distribuidor = require('../fila/distribuidor');
const { subscribe } = require('../realtime/hub');

const TENANT = 1; // tenant fixo que fakeConnFila devolve para tenantDoDepartamento

// ---------- presença ----------

test('presence: refcount — 2 abas, fechar 1 continua online', () => {
  presence._reset();
  presence.conectar({ atendenteId: 1, tenantId: TENANT, deptoIds: [10], matricula: 100, nome: 'A' });
  presence.conectar({ atendenteId: 1, tenantId: TENANT, deptoIds: [10] });
  presence.desconectar(1);
  assert.deepEqual(presence.onlineDoDepto(10), [1]); // ainda online (1 conexão)
});

test('presence: graça — última conexão caiu mas ainda conta online até a graça vencer', () => {
  presence._reset();
  presence.conectar({ atendenteId: 2, tenantId: TENANT, deptoIds: [10] });
  presence.desconectar(2);
  // dentro do período de graça ainda é online
  assert.deepEqual(presence.onlineDoDepto(10), [2]);
});

test('presence: pausado não entra na lista do departamento', () => {
  presence._reset();
  presence.conectar({ atendenteId: 3, tenantId: TENANT, deptoIds: [10], pausado: true });
  presence.conectar({ atendenteId: 4, tenantId: TENANT, deptoIds: [10] });
  assert.deepEqual(presence.onlineDoDepto(10), [4]);
});

test('presence: snapshot reflete estados', () => {
  presence._reset();
  presence.conectar({ atendenteId: 5, tenantId: TENANT, deptoIds: [1], nome: 'On', matricula: 5 });
  presence.conectar({ atendenteId: 6, tenantId: TENANT, deptoIds: [1], nome: 'Pausa', matricula: 6, pausado: true });
  const s = Object.fromEntries(presence.snapshot().map((x) => [x.atendenteId, x.estado]));
  assert.equal(s[5], 'online');
  assert.equal(s[6], 'pausa');
});

test('presence: onlineDoDepto com tenantId filtra defensivamente por tenant', () => {
  presence._reset();
  presence.conectar({ atendenteId: 7, tenantId: 1, deptoIds: [10] });
  presence.conectar({ atendenteId: 8, tenantId: 2, deptoIds: [10] });
  assert.deepEqual(presence.onlineDoDepto(10, 1), [7]);
  assert.deepEqual(presence.onlineDoDepto(10, 2), [8]);
  assert.deepEqual(presence.onlineDoDepto(10).sort(), [7, 8]); // sem tenantId: sem filtro (compat bot/runtime.js)
});

test('presence: snapshot com tenantId só devolve o do tenant pedido', () => {
  presence._reset();
  presence.conectar({ atendenteId: 9, tenantId: 1, deptoIds: [] });
  presence.conectar({ atendenteId: 10, tenantId: 2, deptoIds: [] });
  const ids = presence.snapshot(1).map((x) => x.atendenteId);
  assert.deepEqual(ids, [9]);
});

// ---------- distribuidor ----------

// Emula a exigência do helper de binds: bind :nome no SQL precisa de valor no
// objeto e vice-versa (mesma regra que o Oracle original, que os testes já
// emulavam) — o mock frouxo deixou passar um bind sobrando que quebrou a
// distribuição em produção.
function validarBinds(sql, binds = {}) {
  const noSql = new Set([...String(sql).matchAll(/:([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const noObj = Object.keys(binds);
  for (const k of noObj) if (!noSql.has(k)) throw new Error(`bind :${k} não existe no SQL`);
  for (const k of noSql) if (!noObj.includes(k)) throw new Error(`bind :${k} sem valor`);
}

function fakeConnFila({ fila = [], cargas = {}, capturas = [], falhaUpdate = false, tenantId = TENANT, lockAdquirido = true }) {
  // fila: IDs (sem número) OU objetos { id, numeroId }.
  const itens = fila.map((f) => (typeof f === 'object' ? f : { id: f, numeroId: null }));
  let idx = 0;
  return {
    async execute(sql, binds = {}) {
      validarBinds(sql, binds);
      capturas.push({ sql, binds });

      // Resolução de tenant a partir do departamento (caminho privilegiado,
      // fora de comTenant). tenantId null simula RLS bloqueando essa leitura
      // (ex.: DB_APP_ROLE apontando pra um role sem BYPASSRLS) — zero linhas.
      if (sql.includes('FROM departamento WHERE id')) {
        return tenantId == null ? { rows: [] } : { rows: [{ TENANT_ID: tenantId }] };
      }
      // SET LOCAL ROLE / set_config (comTenant) — não precisam de simulação real.
      if (sql.startsWith('SET LOCAL ROLE') || sql.includes('set_config')) {
        return { rows: [], outBinds: {} };
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ ADQUIRIDO: lockAdquirido }] };
      }

      if (sql.includes(`fila_status = 'aguardando' AND departamento_id = :d`) && sql.includes('SELECT id')) {
        // Simula o filtro por número (placeholders :n0..) — devolve o 1º item da
        // fila que o(s) candidato(s) conseguem atender (resto fica na fila).
        const nums = Object.keys(binds).filter((k) => /^n\d+$/.test(k)).map((k) => binds[k]);
        const temFiltro = nums.length > 0;
        while (idx < itens.length) {
          const it = itens[idx++];
          if (!temFiltro || it.numeroId == null || nums.includes(it.numeroId)) {
            return { rows: [{ ID: it.id, NUMERO_ID: it.numeroId }] };
          }
        }
        return { rows: [] };
      }
      if (sql.includes('COUNT(*) AS qtd FROM conversa') && sql.includes('em_atendimento')) {
        return { rows: Object.entries(cargas).map(([a, q]) => ({ ATENDENTE_ID: Number(a), QTD: q })) };
      }
      if (sql.startsWith('UPDATE conversa')) {
        return { rowsAffected: falhaUpdate ? 0 : 1 };
      }
      if (sql.includes(`SELECT COUNT(*) AS qtd`)) {
        return { rows: [{ QTD: 0 }] };
      }
      return { rows: [], outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('distribuidor: escolhe o atendente com MENOS conversas', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 11, tenantId: TENANT, deptoIds: [7] });
  presence.conectar({ atendenteId: 12, tenantId: TENANT, deptoIds: [7] });
  const capturas = [];
  const conn = fakeConnFila({ fila: [501], cargas: { 11: 3, 12: 1 }, capturas });
  db.getConnection = async () => conn; // mesma conexão = estado da fila compartilhado

  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(7);
  off();

  assert.equal(evento.conversaId, 501);
  assert.equal(evento.atendenteId, 12); // menor carga
  assert.equal(evento.tenantId, TENANT);
});

test('distribuidor: empate de carga → quem está há mais tempo sem receber', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 21, tenantId: TENANT, deptoIds: [8] });
  presence.conectar({ atendenteId: 22, tenantId: TENANT, deptoIds: [8] });
  presence.marcarAtribuicao(21); // 21 recebeu agora; 22 nunca recebeu
  const conn = fakeConnFila({ fila: [601], cargas: { 21: 2, 22: 2 } });
  db.getConnection = async () => conn;

  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(8);
  off();

  assert.equal(evento.atendenteId, 22);
});

test('distribuidor: acesso por número — só quem atende o número da conversa recebe', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 41, tenantId: TENANT, deptoIds: [3], numeroIds: [99] });   // só nº 99 (ativo)
  presence.conectar({ atendenteId: 42, tenantId: TENANT, deptoIds: [3], numeroIds: [88] });   // só nº 88 (receptivo)
  const conn = fakeConnFila({ fila: [{ id: 901, numeroId: 88 }], cargas: {} }); // conversa do nº 88
  db.getConnection = async () => conn;

  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(3);
  off();

  assert.equal(evento.conversaId, 901);
  assert.equal(evento.atendenteId, 42); // o que atende o nº 88, não o 41
});

test('distribuidor: nº sem candidato NÃO trava a fila (head-of-line) — pega a próxima atendível', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 51, tenantId: TENANT, deptoIds: [3], numeroIds: [88] }); // só receptivo (88)
  // Fila: conversa ativa (99, sem candidato) ANTES da receptiva (88, com candidato).
  const conn = fakeConnFila({ fila: [{ id: 1001, numeroId: 99 }, { id: 1002, numeroId: 88 }] });
  db.getConnection = async () => conn;

  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(3);
  off();

  assert.equal(evento.atendenteId, 51);
  assert.equal(evento.conversaId, 1002); // pulou a 1001 (nº 99 sem candidato online)
});

test('distribuidor: atendente irrestrito (sem números) atende qualquer número', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 61, tenantId: TENANT, deptoIds: [3] }); // sem numeroIds = todos
  const conn = fakeConnFila({ fila: [{ id: 1101, numeroId: 99 }] });
  db.getConnection = async () => conn;

  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(3);
  off();

  assert.equal(evento.atendenteId, 61);
  assert.equal(evento.conversaId, 1101);
});

test('distribuidor: ninguém online → conversa fica aguardando (sem UPDATE nem consulta ao banco)', async () => {
  presence._reset();
  const capturas = [];
  const conn = fakeConnFila({ fila: [701], capturas });
  db.getConnection = async () => conn;
  await distribuidor.atribuir(9);
  assert.equal(capturas.length, 0); // nem a resolução de tenant roda — checagem em memória primeiro
});

test('distribuidor: perdeu a corrida (rowsAffected=0) → não publica atribuição', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 31, tenantId: TENANT, deptoIds: [13] });
  // 1ª rodada: acha 801 mas o UPDATE falha; re-tenta e a fila está vazia.
  const conn = fakeConnFila({ fila: [801], falhaUpdate: true });
  db.getConnection = async () => conn;

  let evento = null;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(13);
  await new Promise((r) => setTimeout(r, 30)); // re-tentativa encadeada
  off();

  assert.equal(evento, null);
});

test('distribuidor: perde lock do tenant e re-tenta no próximo tick', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 32, tenantId: TENANT, deptoIds: [14] });
  let tentativas = 0;
  const fila = [802];
  const conn = {
    async execute(sql, binds = {}) {
      validarBinds(sql, binds);
      if (sql.includes('FROM departamento WHERE id')) return { rows: [{ TENANT_ID: TENANT }] };
      if (sql.startsWith('SET LOCAL ROLE') || sql.includes('set_config')) return { rows: [] };
      if (sql.includes('pg_try_advisory_xact_lock')) {
        tentativas++;
        return { rows: [{ ADQUIRIDO: tentativas > 1 }] };
      }
      if (sql.includes("fila_status = 'aguardando' AND departamento_id = :d") && sql.includes('SELECT id')) {
        return { rows: fila.length ? [{ ID: fila.shift(), NUMERO_ID: null }] : [] };
      }
      if (sql.includes('COUNT(*) AS qtd') && sql.includes('em_atendimento')) return { rows: [] };
      if (sql.startsWith('UPDATE conversa')) return { rowsAffected: 1 };
      if (sql.includes('SELECT COUNT(*) AS qtd')) return { rows: [{ QTD: 0 }] };
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
  db.getConnection = async () => conn;
  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  try {
    await distribuidor.atribuir(14);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(tentativas >= 2);
    assert.equal(evento.conversaId, 802);
  } finally {
    off();
  }
});

test('distribuidor: isolamento de tenant — nunca escolhe atendente de OUTRO tenant', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 71, tenantId: 1, deptoIds: [20] }); // tenant certo (fakeConnFila resolve depto 20 → tenant 1)
  presence.conectar({ atendenteId: 72, tenantId: 2, deptoIds: [20] }); // tenant ERRADO — nunca pode ser escolhido
  const capturas = [];
  const conn = fakeConnFila({ fila: [1201], cargas: {}, capturas, tenantId: 1 });
  db.getConnection = async () => conn;

  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(20);
  off();

  assert.equal(evento.atendenteId, 71);
  assert.equal(evento.tenantId, 1);
  // o atendente do tenant 2 nunca entra nem no bind da consulta de carga.
  const cargasCall = capturas.find((c) => c.sql.startsWith('SELECT atendente_id'));
  assert.equal(Object.values(cargasCall.binds).includes(72), false);
});

test('distribuidor: modo app-role (bypass de RLS desligado) — tenantDoDepartamento vazio não trava e AVISA no log', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 81, tenantId: 1, deptoIds: [30] }); // gente online alegando o depto 30
  const capturas = [];
  // tenantId: null → fakeConnFila simula a leitura crua de `departamento`
  // devolvendo ZERO linhas, como aconteceria se DB_APP_ROLE apontasse a
  // conexão pra um role SEM bypass de RLS (ver cabeçalho de distribuidor.js).
  const conn = fakeConnFila({ fila: [901], capturas, tenantId: null });
  db.getConnection = async () => conn;

  const avisos = [];
  const originalError = console.error;
  console.error = (...args) => avisos.push(args.join(' '));
  try {
    await distribuidor.atribuir(30);
  } finally {
    console.error = originalError;
  }

  // Não travou, não jogou exceção pra fora (atribuir engole erro e loga) —
  // e, principalmente, NÃO ficou em silêncio: alguém teria como notar em prod.
  assert.equal(capturas.some((c) => c.sql.startsWith('UPDATE conversa')), false);
  assert.ok(
    avisos.some((a) => /tenantDoDepartamento\(30\)/.test(a) && /DB_APP_ROLE/.test(a)),
    'esperava aviso explicando a causa provável (depto removido OU bypass de RLS desligado)'
  );
});
