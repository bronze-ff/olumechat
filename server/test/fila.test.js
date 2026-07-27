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

// ---------- presença ----------

test('presence: refcount — 2 abas, fechar 1 continua online', () => {
  presence._reset();
  presence.conectar({ atendenteId: 1, deptoIds: [10], matricula: 100, nome: 'A' });
  presence.conectar({ atendenteId: 1, deptoIds: [10] });
  presence.desconectar(1);
  assert.deepEqual(presence.onlineDoDepto(10), [1]); // ainda online (1 conexão)
});

test('presence: graça — última conexão caiu mas ainda conta online até a graça vencer', () => {
  presence._reset();
  presence.conectar({ atendenteId: 2, deptoIds: [10] });
  presence.desconectar(2);
  // dentro do período de graça ainda é online
  assert.deepEqual(presence.onlineDoDepto(10), [2]);
});

test('presence: pausado não entra na lista do departamento', () => {
  presence._reset();
  presence.conectar({ atendenteId: 3, deptoIds: [10], pausado: true });
  presence.conectar({ atendenteId: 4, deptoIds: [10] });
  assert.deepEqual(presence.onlineDoDepto(10), [4]);
});

test('presence: snapshot reflete estados', () => {
  presence._reset();
  presence.conectar({ atendenteId: 5, deptoIds: [1], nome: 'On', matricula: 5 });
  presence.conectar({ atendenteId: 6, deptoIds: [1], nome: 'Pausa', matricula: 6, pausado: true });
  const s = Object.fromEntries(presence.snapshot().map((x) => [x.atendenteId, x.estado]));
  assert.equal(s[5], 'online');
  assert.equal(s[6], 'pausa');
});

// ---------- distribuidor ----------

// Emula a exigência do Oracle: binds casam EXATAMENTE com os :placeholders.
// Bind sobrando = ORA-01036; placeholder sem bind = ORA-01008. O mock frouxo
// deixou passar um bind sobrando que quebrou a distribuição em produção.
function validarBinds(sql, binds = {}) {
  const noSql = new Set([...String(sql).matchAll(/:([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1]));
  const noObj = Object.keys(binds);
  for (const k of noObj) if (!noSql.has(k)) throw new Error(`ORA-01036 (simulado): bind :${k} não existe no SQL`);
  for (const k of noSql) if (!noObj.includes(k)) throw new Error(`ORA-01008 (simulado): bind :${k} sem valor`);
}

function fakeConnFila({ fila = [], cargas = {}, capturas = [], falhaUpdate = false }) {
  // fila: IDs (sem número) OU objetos { id, numeroId }.
  const itens = fila.map((f) => (typeof f === 'object' ? f : { id: f, numeroId: null }));
  let idx = 0;
  return {
    async execute(sql, binds = {}) {
      validarBinds(sql, binds);
      capturas.push({ sql, binds });
      if (sql.includes(`FILA_STATUS = 'aguardando' AND DEPARTAMENTO_ID = :d`) && sql.includes('SELECT ID')) {
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
      if (sql.includes('COUNT(*) AS QTD FROM MC_ZAP_CONVERSA') && sql.includes('em_atendimento')) {
        return { rows: Object.entries(cargas).map(([a, q]) => ({ ATENDENTE_ID: Number(a), QTD: q })) };
      }
      if (sql.startsWith('UPDATE MC_ZAP_CONVERSA')) {
        return { rowsAffected: falhaUpdate ? 0 : 1 };
      }
      if (sql.includes('SELECT COUNT(*) AS QTD')) {
        return { rows: [{ QTD: 0 }] };
      }
      return { rows: [], outBinds: {} };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('distribuidor: escolhe o atendente com MENOS conversas', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 11, deptoIds: [7] });
  presence.conectar({ atendenteId: 12, deptoIds: [7] });
  const capturas = [];
  const conn = fakeConnFila({ fila: [501], cargas: { 11: 3, 12: 1 }, capturas });
  db.getConnection = async () => conn; // mesma conexão = estado da fila compartilhado

  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(7);
  off();

  assert.equal(evento.conversaId, 501);
  assert.equal(evento.atendenteId, 12); // menor carga
});

test('distribuidor: empate de carga → quem está há mais tempo sem receber', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 21, deptoIds: [8] });
  presence.conectar({ atendenteId: 22, deptoIds: [8] });
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
  presence.conectar({ atendenteId: 41, deptoIds: [3], numeroIds: [99] });   // só nº 99 (ativo)
  presence.conectar({ atendenteId: 42, deptoIds: [3], numeroIds: [88] });   // só nº 88 (receptivo)
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
  presence.conectar({ atendenteId: 51, deptoIds: [3], numeroIds: [88] }); // só receptivo (88)
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
  presence.conectar({ atendenteId: 61, deptoIds: [3] }); // sem numeroIds = todos
  const conn = fakeConnFila({ fila: [{ id: 1101, numeroId: 99 }] });
  db.getConnection = async () => conn;

  let evento;
  const off = subscribe((e) => { if (e.tipo === 'atribuicao') evento = e; });
  await distribuidor.atribuir(3);
  off();

  assert.equal(evento.atendenteId, 61);
  assert.equal(evento.conversaId, 1101);
});

test('distribuidor: ninguém online → conversa fica aguardando (sem UPDATE)', async () => {
  presence._reset();
  const capturas = [];
  const conn = fakeConnFila({ fila: [701], capturas });
  db.getConnection = async () => conn;
  await distribuidor.atribuir(9);
  assert.equal(capturas.some((c) => c.sql.startsWith('UPDATE')), false);
});

test('distribuidor: perdeu a corrida (rowsAffected=0) → não publica atribuição', async () => {
  presence._reset();
  presence.conectar({ atendenteId: 31, deptoIds: [13] });
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
