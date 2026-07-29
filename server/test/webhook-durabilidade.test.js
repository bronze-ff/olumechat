// FIL-94 — entrada DURÁVEL do webhook da Meta (docs/DEPLOY_VPS.md §P0.6).
//
// Critério de aceite do documento: "matar o processo logo depois do ACK não
// perde nem duplica a mensagem". Aqui provamos as três pernas disso sem banco
// e sem rede:
//   (1) a CHAVE IDEMPOTENTE é derivada dos identificadores da Meta — reentrega
//       do mesmo evento colapsa, evento novo nunca colapsa;
//   (2) o STORE só deixa UM dono processar cada evento (reivindicação atômica
//       por estado) e registra atraso/falha definitiva;
//   (3) a camada de durabilidade persiste ANTES do ACK, não reprocessa
//       duplicado e devolve os eventos órfãos ao trilho depois de um restart.
//
// O SQL de verdade é exercitado em migracao-023-webhook-evento.test.js
// (Postgres real, com TEST_DATABASE_URL).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/pool');
const store = require('../webhook/eventoStore');

// ---------------------------------------------------------------------------
// Conexão falsa: registra o SQL executado e devolve o que o teste combinar.
// ---------------------------------------------------------------------------
function usarFake(responder) {
  const chamadas = [];
  db.getConnection = async () => ({
    async execute(sql, binds = {}, opts = {}) {
      chamadas.push({ sql, binds, opts });
      const r = responder ? await responder(sql, binds) : undefined;
      return r || { rows: [], rowsAffected: 0 };
    },
    async commit() {}, async rollback() {}, async close() {},
  });
  return chamadas;
}

const getConnectionOriginal = db.getConnection;
test.afterEach(() => { db.getConnection = getConnectionOriginal; });

function payloadMensagem(wamid, texto = 'oi') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '9998887776',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '556230000000', phone_number_id: '1112223334' },
          contacts: [{ profile: { name: 'Ana' }, wa_id: '5562999990000' }],
          messages: [{ from: '5562999990000', id: wamid, timestamp: '1750000000', type: 'text', text: { body: texto } }],
        },
      }],
    }],
  };
}

function payloadStatus(wamid, status, timestamp = '1750000000') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '9998887776',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '1112223334' },
          statuses: [{ id: wamid, status, timestamp, recipient_id: '5562999990000' }],
        },
      }],
    }],
  };
}

const bruto = (p) => Buffer.from(JSON.stringify(p));

// ===================== (1) chave idempotente =====================
test('chave idempotente: o MESMO evento da Meta gera a mesma chave', () => {
  const p = payloadMensagem('wamid.AAA');
  assert.equal(store.chaveIdempotente(bruto(p), p), store.chaveIdempotente(bruto(p), p));
});

test('chave idempotente: vem do identificador da Meta, não dos bytes — reentrega reformatada colapsa', () => {
  const p = payloadMensagem('wamid.AAA');
  const reformatado = Buffer.from(JSON.stringify(p, null, 2)); // mesmos dados, outros bytes
  assert.equal(
    store.chaveIdempotente(bruto(p), p),
    store.chaveIdempotente(reformatado, JSON.parse(reformatado.toString('utf8')))
  );
});

test('chave idempotente: WAMID diferente = evento diferente (nunca colapsa mensagem nova)', () => {
  const a = payloadMensagem('wamid.AAA');
  const b = payloadMensagem('wamid.BBB');
  assert.notEqual(store.chaveIdempotente(bruto(a), a), store.chaveIdempotente(bruto(b), b));
});

test('chave idempotente: sent e delivered do MESMO wamid são eventos distintos', () => {
  const enviado = payloadStatus('wamid.AAA', 'sent');
  const entregue = payloadStatus('wamid.AAA', 'delivered');
  assert.notEqual(
    store.chaveIdempotente(bruto(enviado), enviado),
    store.chaveIdempotente(bruto(entregue), entregue)
  );
});

test('chave idempotente: payload sem mensagem nem status cai no hash do corpo bruto', () => {
  const a = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'account_alerts', value: { x: 1 } }] }] };
  const b = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'account_alerts', value: { x: 2 } }] }] };
  assert.equal(store.chaveIdempotente(bruto(a), a), store.chaveIdempotente(bruto(a), a));
  assert.notEqual(store.chaveIdempotente(bruto(a), a), store.chaveIdempotente(bruto(b), b));
});

test('chave idempotente: cabe na coluna (<= 120 chars) e não vaza conteúdo da mensagem', () => {
  const p = payloadMensagem('wamid.AAA', 'meu CPF é 123.456.789-00');
  const chave = store.chaveIdempotente(bruto(p), p);
  assert.ok(chave.length <= 120, `chave longa demais: ${chave.length}`);
  assert.ok(!chave.includes('123.456'), 'a chave não pode carregar o texto do cliente');
});

// ===================== (2) store =====================
test('persistir: grava o evento bruto e devolve o id (ON CONFLICT DO NOTHING)', async () => {
  const chamadas = usarFake((sql) => {
    if (sql.startsWith('INSERT INTO webhook_evento')) return { rows: [{ ID: 42 }], rowsAffected: 1 };
  });
  const p = payloadMensagem('wamid.AAA');
  const r = await store.persistir({ rawBody: bruto(p), payload: p, phoneNumberId: '1112223334' });
  assert.deepEqual(r, { id: 42, duplicado: false });
  assert.match(chamadas[0].sql, /ON CONFLICT \(chave_idempotente\) DO NOTHING/);
  assert.equal(chamadas[0].binds.payload, bruto(p).toString('utf8'), 'o payload gravado é o corpo BRUTO');
  assert.equal(chamadas[0].opts.autoCommit, true, 'sem commit o evento não sobrevive ao restart');
});

test('persistir: reentrega da Meta não insere de novo e é sinalizada como duplicada', async () => {
  usarFake(() => ({ rows: [], rowsAffected: 0 })); // o ON CONFLICT não inseriu nada
  const p = payloadMensagem('wamid.AAA');
  const r = await store.persistir({ rawBody: bruto(p), payload: p });
  assert.deepEqual(r, { id: null, duplicado: true });
});

test('reivindicarNovo: só o dono da primeira reivindicação processa', async () => {
  let restam = 1;
  const chamadas = usarFake((sql) => {
    if (sql.startsWith('UPDATE webhook_evento')) {
      const linhas = restam > 0 ? [{ ID: 42 }] : [];
      restam -= 1;
      return { rows: linhas, rowsAffected: linhas.length };
    }
  });
  assert.equal(await store.reivindicarNovo(42), true);
  assert.equal(await store.reivindicarNovo(42), false, 'segunda reivindicação do mesmo evento tem que perder');
  assert.match(chamadas[0].sql, /estado = 'processando'/);
  assert.match(chamadas[0].sql, /tentativas = tentativas \+ 1/);
  assert.match(chamadas[0].sql, /estado = 'recebido'/, 'a guarda de estado é o que serializa os donos');
});

test('concluir: fecha o evento e devolve o atraso medido no banco', async () => {
  const chamadas = usarFake((sql) => {
    if (sql.startsWith('UPDATE webhook_evento')) return { rows: [{ ATRASO_MS: 1234 }], rowsAffected: 1 };
  });
  assert.deepEqual(await store.concluir(42), { atrasoMs: 1234 });
  assert.match(chamadas[0].sql, /estado = 'concluido'/);
});

test('falhar: abaixo do limite volta para recebido (a recuperação tenta de novo)', async () => {
  usarFake((sql) => {
    if (sql.startsWith('UPDATE webhook_evento')) return { rows: [{ ESTADO: 'recebido', TENTATIVAS: 1 }], rowsAffected: 1 };
  });
  const r = await store.falhar(42, new Error('timeout na Graph'), 5);
  assert.deepEqual(r, { estado: 'recebido', tentativas: 1, definitivo: false });
});

test('falhar: no limite de tentativas registra falha DEFINITIVA', async () => {
  const chamadas = usarFake((sql) => {
    if (sql.startsWith('UPDATE webhook_evento')) return { rows: [{ ESTADO: 'falhou', TENTATIVAS: 5 }], rowsAffected: 1 };
  });
  const r = await store.falhar(42, new Error('payload inválido'), 5);
  assert.deepEqual(r, { estado: 'falhou', tentativas: 5, definitivo: true });
  assert.equal(chamadas[0].binds.max, 5);
  assert.match(String(chamadas[0].binds.erro), /payload inválido/);
});

test('falhar: mensagem de erro é truncada (não vira um TOAST gigante por evento)', async () => {
  const chamadas = usarFake((sql) => {
    if (sql.startsWith('UPDATE webhook_evento')) return { rows: [{ ESTADO: 'recebido', TENTATIVAS: 1 }] };
  });
  await store.falhar(42, new Error('x'.repeat(9000)), 5);
  assert.ok(chamadas[0].binds.erro.length <= 2000, 'erro sem teto de tamanho');
});

test('candidatosOrfaos: procura só eventos não concluídos, velhos e dentro do limite de tentativas', async () => {
  const chamadas = usarFake((sql) => {
    if (sql.startsWith('SELECT')) return { rows: [{ ID: 7, PAYLOAD: '{"entry":[]}', TENTATIVAS: 1 }] };
  });
  const linhas = await store.candidatosOrfaos({ orfaoMin: 2, maxTentativas: 5, limite: 50 });
  assert.deepEqual(linhas, [{ id: 7, payload: '{"entry":[]}', tentativas: 1 }]);
  assert.match(chamadas[0].sql, /estado IN \('recebido', 'processando'\)/);
  assert.match(chamadas[0].sql, /tentativas < :max/);
  assert.deepEqual(
    { min: chamadas[0].binds.orfaoMin, max: chamadas[0].binds.max, lim: chamadas[0].binds.limite },
    { min: 2, max: 5, lim: 50 }
  );
});

test('reivindicarOrfao: exige a MESMA janela de orfandade na hora de reivindicar (anti-corrida)', async () => {
  const chamadas = usarFake((sql) => {
    if (sql.startsWith('UPDATE webhook_evento')) return { rows: [{ ID: 7 }], rowsAffected: 1 };
  });
  assert.equal(await store.reivindicarOrfao(7, 2), true);
  assert.match(chamadas[0].sql, /COALESCE\(tentado_em, recebido_em\)/);
  assert.equal(chamadas[0].binds.orfaoMin, 2);
});

test('pendentes: gauge de "evento persistido sem conclusão" para o alerta da seção 9', async () => {
  usarFake((sql) => {
    if (sql.startsWith('SELECT')) return { rows: [{ TOTAL: 3, MAIS_ANTIGO_SEG: 900, FALHAS: 1 }] };
  });
  assert.deepEqual(await store.pendentes(), { total: 3, maisAntigoSeg: 900, falhas: 1 });
});

test('purgarConcluidos: retenção só apaga evento JÁ concluído', async () => {
  const chamadas = usarFake((sql) => {
    if (sql.startsWith('DELETE')) return { rowsAffected: 12 };
  });
  assert.equal(await store.purgarConcluidos(7), 12);
  assert.match(chamadas[0].sql, /estado = 'concluido'/);
  assert.equal(chamadas[0].binds.dias, 7);
});
