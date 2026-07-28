'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
// FIL-84 — tempo real e corrida do takeover no runtime da IA.
//
// (1) TEMPO REAL: ia/runtime.js chamava `publish` ZERO vezes, diferente do
//     bot/runtime.js. Por isso a resposta da IA só aparecia na tela no polling
//     de 60s — e um botão "Assumir" sem ver a conversa ao vivo não faz sentido.
//
// (2) CORRIDA: a IA processa em 3 fases. Entre a fase 1 e o envio da resposta
//     (fase 3) cabe uma chamada de até 45s ao provedor — tempo de sobra para o
//     atendente clicar em Assumir. Sem rechecar `fila_status` ANTES de enviar,
//     "a IA cala na hora" é mentira: o cliente recebe a fala da IA depois de o
//     humano já ter assumido. O turno fica no histórico; nada chega ao cliente.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const store = require('../ia/iaConfigStore');
const client = require('../ia/client');
const auth = require('../ia/autorizacao');
const runtime = require('../ia/runtime');
const { subscribe } = require('../realtime/hub');

const TENANT = 1;

/**
 * Conexão falsa cujo `fila_status` pode MUDAR entre as leituras — é assim que
 * se encena a corrida: a fase 1 lê 'ia', a recheca da fase 3 lê o que o
 * atendente deixou.
 */
function connComFila(sequenciaFilaStatus) {
  const fila = [...sequenciaFilaStatus];
  let ultimo = fila[0];
  function proximo() {
    if (fila.length) ultimo = fila.shift();
    return ultimo;
  }
  return {
    _ins: [], _leiturasFila: 0,
    async execute(sql, binds) {
      if (sql.includes('ia_habilitada')) return { rows: [{ IA_HABILITADA: 'S' }] };
      if (/SELECT fila_status FROM conversa/i.test(sql)) {
        this._leiturasFila += 1;
        return { rows: [{ FILA_STATUS: proximo() }] };
      }
      if (sql.includes('FROM conversa')) {
        return { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000',
          PHONE_NUMBER_ID: '111', FILA_STATUS: proximo(), IA_MODO_TESTE: 'N' }] };
      }
      if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 0 }] };
      if (sql.includes('FROM ia_turno')) return { rows: [] };
      this._ins.push({ sql, binds });
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function prepararProvedor(texto = 'Resposta da IA.') {
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  client.chamar = async () => ({ texto, toolCalls: [] });
}

test('a resposta da IA publica evento de tempo real (senão só aparece no polling de 60s)', async () => {
  const conn = connComFila(['ia', 'ia']); db.getConnection = async () => conn;
  prepararProvedor();
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) }; };

  const eventos = [];
  const cancelar = subscribe((e) => eventos.push(e));
  try {
    await runtime.processarEntrada(TENANT, 88, 'oi');
  } finally { cancelar(); }

  assert.equal(enviados.length, 1, 'a IA respondeu');
  const msg = eventos.find((e) => e.tipo === 'mensagem' && e.conversaId === 88);
  assert.ok(msg, 'nenhum evento de mensagem publicado pelo runtime da IA');
  assert.equal(msg.direcao, 'out');
  assert.equal(msg.tenantId, TENANT, 'o evento tem que carregar o tenantId — o SSE assina por tenant');
});

test('CORRIDA: atendente assume entre a fase 1 e o envio → resposta DESCARTADA', async () => {
  // fila_status: 'ia' na fase 1 … e 'em_atendimento' na recheca da fase 3.
  const conn = connComFila(['ia', 'em_atendimento']); db.getConnection = async () => conn;
  prepararProvedor();
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) }; };

  await runtime.processarEntrada(TENANT, 88, 'oi');

  assert.equal(enviados.length, 0, 'a IA falou depois de o atendente ter assumido');
  assert.ok(conn._leiturasFila > 0, 'o runtime precisa rechecar fila_status ANTES de enviar');
  // O turno FICA no histórico da IA (é o que ela pensou); só não vira mensagem.
  assert.ok(conn._ins.some((i) => /INSERT INTO ia_turno/i.test(i.sql)), 'o turno tem que ficar no histórico');
  assert.ok(!conn._ins.some((i) => /INSERT INTO mensagem/i.test(i.sql)), 'nada pode ser gravado como mensagem');
});

test('o publish só sai DEPOIS do commit (nunca de dentro da transação)', async () => {
  const conn = connComFila(['ia', 'ia']);
  const ordem = [];
  conn.commit = async () => { ordem.push('commit'); };
  db.getConnection = async () => conn;
  prepararProvedor();
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) });

  const cancelar = subscribe((e) => { if (e.tipo === 'mensagem') ordem.push('publish'); });
  try {
    await runtime.processarEntrada(TENANT, 88, 'oi');
  } finally { cancelar(); }

  assert.ok(ordem.includes('publish'), 'o evento precisa ter sido publicado');
  assert.ok(ordem.indexOf('publish') > ordem.lastIndexOf('commit'),
    'o SSE reagiu a um estado que ainda não estava visível fora da transação');
});

// ---------------------------------------------------------------------------
// FIL-84 — a IA decide escalar: fim a fim, do tool-call ao evento de fila.
//
// Obstáculo 4 do ticket: `ia/tools.js` tinha `TOOLS = []` literal e o
// toolExecutor só sabia rodar SQL de disco. Uma ferramenta de "transferir" não
// cabia naquele modelo — daí o executor de operações NOMEADAS.
// ---------------------------------------------------------------------------
test('IA chama transferir_para_humano: muda a fila, avisa o cliente e para de responder', async () => {
  const conn = connComFila(['ia', 'ia', 'ia']); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;

  // A conexão precisa responder também às queries do handoff.
  const executeBase = conn.execute.bind(conn);
  conn.execute = async (sql, binds) => {
    if (/FROM departamento/i.test(sql)) return { rows: [{ ID: 5, NOME: 'Financeiro' }] };
    if (/SELECT fila_status, protocolo FROM conversa/i.test(sql)) return { rows: [{ FILA_STATUS: 'ia', PROTOCOLO: 'P1' }] };
    if (/^UPDATE conversa/i.test(sql)) { conn._ins.push({ sql, binds }); return { rowsAffected: 1 }; }
    return executeBase(sql, binds);
  };

  let volta = 0;
  client.chamar = async () => (volta++ === 0
    ? { texto: '', toolCalls: [{ id: 't1', nome: 'transferir_para_humano', args: { departamento: 'Financeiro', motivo: 'cliente pediu boleto' } }] }
    : { texto: 'ESTA FALA NAO PODE SAIR', toolCalls: [] });

  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) }; };

  const eventos = [];
  const cancelar = subscribe((e) => eventos.push(e));
  try {
    await runtime.processarEntrada(TENANT, 88, 'quero falar com alguém sobre o boleto');
  } finally { cancelar(); }

  assert.equal(volta, 1, 'depois de transferir, o modelo NÃO pode ser chamado de novo');
  assert.equal(enviados.length, 1, 'só a despedida sai');
  assert.match(enviados[0].text.body, /atendente/i);
  assert.ok(!enviados.some((e) => /NAO PODE SAIR/.test(e.text.body)));
  assert.ok(conn._ins.some((i) => /^UPDATE conversa/i.test(i.sql) && /fila_status/i.test(i.sql)), 'a fila tem que mudar');
  assert.ok(eventos.some((e) => e.tipo === 'fila' && e.departamentoId === 5 && e.tenantId === TENANT),
    'a conversa tem que aparecer na fila do departamento na hora');
});
