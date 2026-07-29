// FIL-94 — a camada de durabilidade em volta do processEvent e a recuperação
// pós-restart (docs/DEPLOY_VPS.md §P0.6).
//
// O aceite do documento é: "matar o processo logo depois do ACK não perde nem
// duplica a mensagem". Sem banco e sem rede, isso se prova em três pedaços:
//   • o ACK depende da PERSISTÊNCIA (falha ao gravar → erro recuperável, a Meta
//     reenvia; gravou → 200 mesmo que o processamento depois falhe);
//   • um evento que ficou em `recebido`/`processando` (processo morto no meio)
//     é reprocessado pela varredura — UMA vez, porque a reivindicação é atômica;
//   • reentrega da Meta do MESMO evento não vira trabalho novo.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.GRAPH_VERSION = 'v21.0';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const store = require('../webhook/eventoStore');
const processEvent = require('../webhook/processEvent');
const durabilidade = require('../webhook/durabilidade');
const { buildWebhookRouter } = require('../webhook/routes');

// --- dublês: as funções do store e o processEvent são trocados no módulo,
// mesmo padrão do resto da suíte (db.getConnection = ...). ---
const ORIGINAIS = {
  store: { ...store },
  processPayload: processEvent.processPayload,
};

function restaurar() {
  Object.assign(store, ORIGINAIS.store);
  processEvent.processPayload = ORIGINAIS.processPayload;
  durabilidade.parar();
  durabilidade.zerarMetricas();
}
test.afterEach(restaurar);

const PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '9998887776',
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: '1112223334' },
        contacts: [{ profile: { name: 'Ana' }, wa_id: '5562999990000' }],
        messages: [{ from: '5562999990000', id: 'wamid.AAA', timestamp: '1750000000', type: 'text', text: { body: 'oi' } }],
      },
    }],
  }],
};
const BRUTO = Buffer.from(JSON.stringify(PAYLOAD));

/**
 * Store em memória com a MESMA semântica do SQL do eventoStore, incluindo a
 * JANELA DE ORFANDADE (`COALESCE(tentado_em, recebido_em) <= now() - N min`) —
 * é ela que faz duas reivindicações concorrentes darem apenas um dono, e um
 * dublê sem ela deixaria passar o pior bug possível aqui: processar duas vezes.
 */
function storeEmMemoria() {
  const eventos = new Map();
  let seq = 0;
  const pendente = (ev) => ev.estado === 'recebido' || ev.estado === 'processando';
  const orfao = (ev, orfaoMin) => (ev.tentadoEm || ev.recebidoEm) <= Date.now() - orfaoMin * 60_000;

  store.persistir = async ({ rawBody, payload }) => {
    const chave = ORIGINAIS.store.chaveIdempotente(rawBody, payload);
    for (const ev of eventos.values()) if (ev.chave === chave) return { id: null, duplicado: true };
    const id = ++seq;
    eventos.set(id, {
      id, chave, payload: rawBody.toString('utf8'), estado: 'recebido',
      tentativas: 0, recebidoEm: Date.now(), tentadoEm: null,
    });
    return { id, duplicado: false };
  };
  store.reivindicarNovo = async (id) => {
    const ev = eventos.get(id);
    if (!ev || ev.estado !== 'recebido' || ev.tentativas !== 0) return false;
    ev.estado = 'processando'; ev.tentativas += 1; ev.tentadoEm = Date.now();
    return true;
  };
  store.reivindicarOrfao = async (id, orfaoMin) => {
    const ev = eventos.get(id);
    if (!ev || !pendente(ev) || !orfao(ev, orfaoMin)) return false;
    ev.estado = 'processando'; ev.tentativas += 1; ev.tentadoEm = Date.now();
    return true;
  };
  store.concluir = async (id) => {
    const ev = eventos.get(id);
    if (ev) ev.estado = 'concluido';
    return { atrasoMs: 10 };
  };
  store.falhar = async (id, erro, max) => {
    const ev = eventos.get(id);
    if (!ev) return { estado: null, tentativas: null, definitivo: false };
    ev.estado = ev.tentativas >= max ? 'falhou' : 'recebido';
    ev.erro = String(erro && erro.message);
    return { estado: ev.estado, tentativas: ev.tentativas, definitivo: ev.estado === 'falhou' };
  };
  store.candidatosOrfaos = async ({ orfaoMin, maxTentativas, limite }) => [...eventos.values()]
    .filter((ev) => pendente(ev) && ev.tentativas < maxTentativas && orfao(ev, orfaoMin))
    .slice(0, limite)
    .map((ev) => ({ id: ev.id, payload: ev.payload, tentativas: ev.tentativas }));
  store.pendentes = async () => ({
    total: [...eventos.values()].filter(pendente).length,
    maisAntigoSeg: 0,
    falhas: [...eventos.values()].filter((e) => e.estado === 'falhou').length,
  });
  store.purgarConcluidos = async () => 0;
  return eventos;
}

/** Envelhece os eventos pendentes: é o "o processo ficou fora do ar N minutos"
    que a janela de orfandade espera antes de considerar um evento abandonado. */
function envelhecer(eventos, minutos = 10) {
  const delta = minutos * 60_000;
  for (const ev of eventos.values()) {
    ev.recebidoEm -= delta;
    if (ev.tentadoEm) ev.tentadoEm -= delta;
  }
}

// ===================== ACK depende da persistência =====================
function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function startServer() {
  const app = express();
  app.use('/', buildWebhookRouter({ verifyToken: 'verify123', appSecret: 'test_app_secret' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function postWebhook(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'POST', hostname: '127.0.0.1', port, path: '/webhook',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-hub-signature-256': sign(Buffer.from(body), 'test_app_secret'),
        } },
      (res) => { let o = ''; res.on('data', (c) => (o += c)); res.on('end', () => resolve({ status: res.statusCode, body: o })); }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Espera o processamento pós-ACK (setImmediate + awaits) terminar. */
const respirar = () => new Promise((r) => setTimeout(r, 30));

test('POST /webhook: grava o evento ANTES de responder 200', async () => {
  const eventos = storeEmMemoria();
  processEvent.processPayload = async () => {};
  const { server, port } = await startServer();
  try {
    const r = await postWebhook(port, JSON.stringify(PAYLOAD));
    assert.equal(r.status, 200);
    assert.equal(eventos.size, 1, 'o ACK saiu sem o evento no banco');
  } finally { server.close(); }
});

test('POST /webhook: falha ao PERSISTIR responde erro recuperável (a Meta reenvia)', async () => {
  storeEmMemoria();
  let processou = false;
  processEvent.processPayload = async () => { processou = true; };
  store.persistir = async () => { throw new Error('banco indisponível'); };
  const { server, port } = await startServer();
  try {
    const r = await postWebhook(port, JSON.stringify(PAYLOAD));
    assert.equal(r.status, 503, 'sem 5xx a Meta considera entregue e o evento se perde');
    await respirar();
    assert.equal(processou, false, 'não pode processar o que não foi persistido');
  } finally { server.close(); }
});

test('POST /webhook: evento persistido dá 200 mesmo se o processamento falhar depois', async () => {
  const eventos = storeEmMemoria();
  processEvent.processPayload = async () => { throw new Error('Graph fora do ar'); };
  const { server, port } = await startServer();
  try {
    const r = await postWebhook(port, JSON.stringify(PAYLOAD));
    assert.equal(r.status, 200, 'o evento já é durável — reenvio da Meta só duplicaria trabalho');
    await respirar();
    assert.equal([...eventos.values()][0].estado, 'recebido', 'falha recuperável tem que voltar para a fila');
  } finally { server.close(); }
});

test('POST /webhook: reentrega da Meta do MESMO evento não processa de novo', async () => {
  const eventos = storeEmMemoria();
  let processadas = 0;
  processEvent.processPayload = async () => { processadas += 1; };
  const { server, port } = await startServer();
  try {
    assert.equal((await postWebhook(port, JSON.stringify(PAYLOAD))).status, 200);
    await respirar();
    assert.equal((await postWebhook(port, JSON.stringify(PAYLOAD))).status, 200);
    await respirar();
    assert.equal(processadas, 1, 'redelivery duplicou o processamento');
    assert.equal(eventos.size, 1);
  } finally { server.close(); }
});

// ===================== aceite: morrer depois do ACK =====================
test('aceite §P0.6: processo morto depois do ACK — a varredura reprocessa UMA vez', async () => {
  const eventos = storeEmMemoria();
  let processadas = 0;
  processEvent.processPayload = async () => { processadas += 1; };

  // ACK dado, processo morre antes de processar: o evento fica em 'recebido'.
  const { id } = await durabilidade.receber(BRUTO, PAYLOAD);
  assert.equal(eventos.get(id).estado, 'recebido');
  assert.equal(processadas, 0);

  // Boot novo, depois da janela de orfandade: a varredura devolve o órfão ao
  // trilho (dentro da janela ele é intocado de propósito — a instância antiga
  // de um rolling update ainda pode estar com ele).
  await durabilidade.varrer();
  assert.equal(processadas, 0, 'evento fresco não pode ser reivindicado pela recuperação');
  envelhecer(eventos);
  await durabilidade.varrer();
  assert.equal(processadas, 1, 'evento aceito e não processado é perda de mensagem do cliente');
  assert.equal(eventos.get(id).estado, 'concluido');

  // Tick seguinte não pode reprocessar o que já concluiu.
  await durabilidade.varrer();
  assert.equal(processadas, 1);
});

test('varredura: dois donos disputando o mesmo evento — só um processa', async () => {
  const eventos = storeEmMemoria();
  let processadas = 0;
  processEvent.processPayload = async () => { processadas += 1; };
  const { id } = await durabilidade.receber(BRUTO, PAYLOAD);
  envelhecer(eventos);

  await Promise.all([durabilidade.varrer(), durabilidade.varrer()]);
  assert.equal(processadas, 1, 'reivindicação atômica não segurou a corrida');
  assert.equal(eventos.get(id).estado, 'concluido');
});

test('varredura: payload gravado ilegível vira falha definitiva e não derruba os outros', async () => {
  const eventos = storeEmMemoria();
  const processados = [];
  processEvent.processPayload = async (p) => { processados.push(p.entry[0].id); };
  await durabilidade.receber(BRUTO, PAYLOAD);
  // Evento com JSON corrompido no banco (nunca deveria acontecer — mas se
  // acontecer não pode travar a recuperação para sempre).
  eventos.set(99, {
    id: 99, chave: 'ev:torto', payload: '{isso não é json',
    estado: 'recebido', tentativas: 0, recebidoEm: Date.now(), tentadoEm: null,
  });
  envelhecer(eventos);

  await durabilidade.varrer();
  assert.deepEqual(processados, ['9998887776'], 'o evento bom tem que passar');
  assert.equal(eventos.get(99).estado, 'falhou', 'payload ilegível precisa parar de ser tentado');
});

test('varredura: respeita o limite de tentativas (falha definitiva registrada)', async () => {
  process.env.WEBHOOK_MAX_TENTATIVAS = '2';
  const eventos = storeEmMemoria();
  processEvent.processPayload = async () => { throw new Error('erro permanente'); };
  try {
    const { id } = await durabilidade.receber(BRUTO, PAYLOAD);
    envelhecer(eventos);
    await durabilidade.varrer(); // 1ª tentativa da recuperação
    assert.equal(eventos.get(id).estado, 'recebido');
    envelhecer(eventos);
    await durabilidade.varrer(); // 2ª → atinge o teto
    assert.equal(eventos.get(id).estado, 'falhou');
    assert.equal(durabilidade.metricas().falhasDefinitivas, 1);
  } finally { delete process.env.WEBHOOK_MAX_TENTATIVAS; }
});

// ===================== medição (§9 do plano) =====================
test('medição: contadores de recebido/duplicado/concluído/falha e atraso', async () => {
  storeEmMemoria();
  processEvent.processPayload = async () => {};
  const primeiro = await durabilidade.receber(BRUTO, PAYLOAD);
  await durabilidade.processar(primeiro.id, PAYLOAD);
  await durabilidade.receber(BRUTO, PAYLOAD); // reentrega

  processEvent.processPayload = async () => { throw new Error('falha'); };
  const outro = { ...PAYLOAD, entry: [{ ...PAYLOAD.entry[0], changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1112223334' }, messages: [{ from: '5562999990000', id: 'wamid.BBB', timestamp: '1750000001', type: 'text', text: { body: 'oi' } }] } }] }] };
  const segundo = await durabilidade.receber(Buffer.from(JSON.stringify(outro)), outro);
  await durabilidade.processar(segundo.id, outro);

  const m = durabilidade.metricas();
  assert.equal(m.recebidos, 2);
  assert.equal(m.duplicados, 1);
  assert.equal(m.concluidos, 1);
  assert.equal(m.falhas, 1);
  assert.ok(m.atrasoMaxMs >= 0, 'sem atraso medido não há alerta de atraso');
});

test('medição: o tick publica o gauge de pendentes/falhas (alerta "evento sem conclusão")', async () => {
  storeEmMemoria();
  processEvent.processPayload = async () => {};
  const ev = await durabilidade.receber(BRUTO, PAYLOAD);
  await durabilidade.processar(ev.id, PAYLOAD);
  await durabilidade.varrer();
  const m = durabilidade.metricas();
  assert.equal(m.pendentes, 0);
  assert.equal(m.falhasPersistidas, 0);
});
