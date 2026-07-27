// Integração bot/runtime.js × bot/engine.js: conversa já em 'bot' recebe a
// saudação; resposta navega o menu; comTenant() sempre abre com o tenantId
// recebido do chamador.
//
// ANTES este arquivo também testava webhook/processEvent.js (criação da
// conversa, opt-out por "PARAR") em conjunto com o runtime. Esse módulo é do
// FIL-60 (fora do escopo do FIL-62) e ainda não foi portado para Postgres —
// runtime.js agora exige tenantId como 1º parâmetro (iniciarFluxo,
// processarEntrada, expirar), contrato que só a borda do webhook, já portada,
// vai poder cumprir. Esses testes passam a exercitar só runtime+engine,
// diretamente; a integração completa com o webhook fica pro FIL-60.
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
const hub = require('../realtime/hub');
const distribuidor = require('../fila/distribuidor');
const { invalidar: invalidarConfigCache } = require('../utils/configCache');
const runtime = require('../bot/runtime');

const TENANT_ID = 1;

const FLUXO_DEF = {
  config: { inicio: 'oi', maxInvalidas: 3 },
  nos: [
    { id: 'oi', tipo: 'mensagem', texto: 'Olá {{nome}}! Protocolo {{protocolo}}.', proximo: 'menu' },
    { id: 'menu', tipo: 'menu', texto: '1 - T.I\n2 - Encerrar',
      opcoes: [{ valor: '1', proximo: 'ti' }, { valor: '2', proximo: 'fim' }] },
    { id: 'ti', tipo: 'transferir', departamentoId: 4, texto: 'Encaminhando…' },
    { id: 'fim', tipo: 'encerrar', texto: 'Tchau!' },
  ],
};

const FLUXO_CONSULTA_RUIM = {
  config: { inicio: 'valida', maxInvalidas: 3 },
  nos: [
    { id: 'valida', tipo: 'consulta', sql: 'SELECT nome FROM tabela_que_nao_existe',
      seEncontrado: 'ok', seNaoEncontrado: 'nao_achou' },
    { id: 'ok', tipo: 'mensagem', texto: 'Achei!', proximo: 'fim' },
    { id: 'nao_achou', tipo: 'mensagem', texto: 'Não achei, mas seguimos.', proximo: 'fim' },
    { id: 'fim', tipo: 'encerrar', texto: 'Tchau!' },
  ],
};

/** Fake conn que simula a semântica real do Postgres: uma vez que um comando
    falha dentro da transação, TODO comando seguinte é recusado com 25P02 até
    um ROLLBACK (ou ROLLBACK TO SAVEPOINT) — é o que prova que o SAVEPOINT de
    runtime.js de fato isola a falha em vez de só engolir a exceção em JS. */
function fakeConnComAbort(handler) {
  let abortado = false;
  return {
    async execute(sql, binds) {
      if (/^SAVEPOINT/i.test(sql)) return { rows: [] };
      if (/^RELEASE SAVEPOINT/i.test(sql)) { abortado = false; return { rows: [] }; }
      if (/^ROLLBACK TO SAVEPOINT/i.test(sql)) { abortado = false; return { rows: [] }; }
      if (abortado) {
        const e = new Error('current transaction is aborted, commands ignored until end of transaction block');
        e.code = '25P02';
        throw e;
      }
      const resultado = handler(sql, binds);
      if (resultado && resultado.__abortarAPartirDaqui) { abortado = true; throw resultado.erro; }
      return resultado || { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

/** Fake conn no nível "já wrapped" — o mesmo formato que db.getConnection()
    devolve de verdade (chaves MAIÚSCULAS, jsonb já parseado). comTenant()
    chama execute() para SET LOCAL ROLE/set_config antes da lógica de negócio;
    o default { rows: [] } cobre essas duas chamadas sem precisar de match. */
function fakeConn(handler) {
  return {
    async execute(sql, binds) { return handler(sql, binds) || { rows: [] }; },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function aguardar(ms = 50) { return new Promise((r) => setTimeout(r, ms)); }

test('iniciarFluxo: conversa em bot recebe a saudação e o menu', async () => {
  presence._reset();
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.BOT' + enviados.length }] }) };
  };
  const conn = fakeConn((sql, binds) => {
    capturas.push({ sql, binds });
    if (sql.includes('FROM conversa')) {
      return {
        rows: [{
          ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100077',
          BOT_FLUXO_ID: 9, BOT_NO_ATUAL: null, BOT_VARIAVEIS: null, BOT_INVALIDAS: 0,
          TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
          DEFINICAO: FLUXO_DEF,
        }],
      };
    }
  });
  db.getConnection = async () => conn;

  await runtime.iniciarFluxo(TENANT_ID, 88);
  await aguardar();

  const carregou = capturas.find((c) => c.sql.includes('FROM conversa'));
  assert.equal(carregou.binds.tid, TENANT_ID);

  assert.equal(enviados.length, 2);
  assert.equal(enviados[0].text.body, 'Olá Cliente! Protocolo 260610100077.');
  assert.match(enviados[1].text.body, /1 - T\.I/);
  const updEstado = capturas.find((c) => c.sql.includes('bot_no_atual = :no'));
  assert.equal(updEstado.binds.no, 'menu');
});

test('processarEntrada: "1" em conversa bot transfere pro departamento e vai pra fila', async () => {
  presence._reset();
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.B' + enviados.length }] }) };
  };
  const conn = fakeConn((sql, binds) => {
    capturas.push({ sql, binds });
    if (sql.includes('FROM conversa')) {
      return {
        rows: [{
          ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100077',
          BOT_FLUXO_ID: 9, BOT_NO_ATUAL: 'menu', BOT_VARIAVEIS: {}, BOT_INVALIDAS: 0,
          TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
          DEFINICAO: FLUXO_DEF,
        }],
      };
    }
  });
  db.getConnection = async () => conn;

  await runtime.processarEntrada(TENANT_ID, 88, '1');
  await aguardar();

  assert.match(enviados[0].text.body, /Encaminhando/);
  const updFila = capturas.find((c) => c.sql.includes(`fila_status = 'aguardando'`) && c.sql.startsWith('UPDATE'));
  assert.ok(updFila, 'deve mover pra fila');
  assert.equal(updFila.binds.dep, 4);
  assert.equal(updFila.binds.tid, TENANT_ID);
  const nota = capturas.find((c) => c.sql.includes(`'nota'`));
  assert.ok(nota, 'deve registrar nota interna do bot');
});

test('iniciarFluxo: tenantId inválido não chega a abrir conexão nem a enviar nada', async () => {
  let chamouFetch = false;
  let getConnectionChamado = false;
  global.fetch = async () => { chamouFetch = true; return { ok: true, json: async () => ({}) }; };
  db.getConnection = async () => {
    getConnectionChamado = true;
    throw new Error('não deveria abrir conexão sem tenantId válido');
  };

  await runtime.iniciarFluxo(0, 88); // tenantId inválido: comTenant recusa antes de tocar o banco
  await aguardar();

  assert.equal(getConnectionChamado, false, 'comTenant deve validar tenantId antes de abrir a conexão');
  assert.equal(chamouFetch, false);
});

test('aplicar (transferir): falha ao ler config isola em SAVEPOINT — a transferência ainda se completa', async () => {
  presence._reset();
  invalidarConfigCache(); // força ida ao banco (senão pegaria o cache de outro teste)
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.C' + enviados.length }] }) };
  };
  const conn = fakeConnComAbort((sql, binds) => {
    capturas.push({ sql, binds });
    if (sql.includes('FROM conversa')) {
      return {
        rows: [{
          ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100077',
          BOT_FLUXO_ID: 9, BOT_NO_ATUAL: 'menu', BOT_VARIAVEIS: {}, BOT_INVALIDAS: 0,
          TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
          DEFINICAO: FLUXO_DEF,
        }],
      };
    }
    if (/FROM config\b/.test(sql)) {
      return { __abortarAPartirDaqui: true, erro: new Error('conexão caiu ao ler config') };
    }
    return { rows: [], rowsAffected: 1 };
  });
  db.getConnection = async () => conn;

  await runtime.processarEntrada(TENANT_ID, 88, '1');
  await aguardar();

  // Se o SAVEPOINT não isolasse a falha do lerConfig, a transferência inteira
  // (nota interna + mover pra fila) seria perdida por causa do 25P02.
  assert.match(enviados[0].text.body, /Encaminhando/);
  const updFila = capturas.find((c) => c.sql.includes(`fila_status = 'aguardando'`) && c.sql.startsWith('UPDATE'));
  assert.ok(updFila, 'a transferência deve se completar mesmo com a leitura de config falhando');
  const nota = capturas.find((c) => c.sql.includes(`'nota'`));
  assert.ok(nota, 'a nota interna ainda deve ser gravada');
});

test('executarConsulta: erro de SQL isola em SAVEPOINT — não aborta o resto da transação', async () => {
  presence._reset();
  const capturas = [];
  const enviados = [];
  global.fetch = async (url, opts) => {
    enviados.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.Q' + enviados.length }] }) };
  };
  const conn = fakeConnComAbort((sql, binds) => {
    capturas.push({ sql, binds });
    if (sql.includes('FROM conversa')) {
      return {
        rows: [{
          ID: 77, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100099',
          BOT_FLUXO_ID: 10, BOT_NO_ATUAL: null, BOT_VARIAVEIS: null, BOT_INVALIDAS: 0,
          TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
          DEFINICAO: FLUXO_CONSULTA_RUIM,
        }],
      };
    }
    if (sql.includes('tabela_que_nao_existe')) {
      return { __abortarAPartirDaqui: true, erro: new Error('relation "tabela_que_nao_existe" does not exist') };
    }
    return { rows: [], rowsAffected: 1 };
  });
  db.getConnection = async () => conn;

  await runtime.iniciarFluxo(TENANT_ID, 77);
  await aguardar();

  // Se o SAVEPOINT não isolasse a falha, a transação seguiria abortada e NENHUMA
  // destas duas operações (enviar as mensagens, encerrar a conversa) teria êxito.
  assert.equal(enviados.length, 2, 'consulta falhou mas o fluxo seguiu seNaoEncontrado e enviou as mensagens');
  assert.equal(enviados[0].text.body, 'Não achei, mas seguimos.');
  assert.equal(enviados[1].text.body, 'Tchau!');
  const encerrou = capturas.find((c) => c.sql.includes(`status = 'resolvida'`) && c.sql.startsWith('UPDATE'));
  assert.ok(encerrou, 'o encerramento deve persistir mesmo após a consulta falhar');
});

test('aplicar: publish/distribuidor.atribuir só depois do commit, e o evento carrega tenantId', async () => {
  presence._reset();
  const eventosDaConversa = [];
  const cancelar = hub.subscribe((evt) => { if (evt.conversaId === 88) eventosDaConversa.push(evt); });
  const atribuirOriginal = distribuidor.atribuir;
  const ordem = [];
  distribuidor.atribuir = () => { ordem.push('atribuir'); };
  global.fetch = async (url, opts) => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.o' }] }) });
  const conn = {
    async execute(sql) {
      if (sql.includes('FROM conversa')) {
        return {
          rows: [{
            ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, FILA_STATUS: 'bot', PROTOCOLO: '260610100077',
            BOT_FLUXO_ID: 9, BOT_NO_ATUAL: 'menu', BOT_VARIAVEIS: {}, BOT_INVALIDAS: 0,
            TELEFONE: '5562999990000', NOME_PERFIL: 'Cliente', PHONE_NUMBER_ID: '1112223334',
            DEFINICAO: FLUXO_DEF,
          }],
        };
      }
      return { rows: [], rowsAffected: 1 };
    },
    commit: async () => { ordem.push('commit'); },
    rollback: async () => {}, close: async () => {},
  };
  db.getConnection = async () => conn;
  try {
    await runtime.processarEntrada(TENANT_ID, 88, '1');
    await aguardar();

    assert.deepEqual(ordem, ['commit', 'atribuir'], 'atribuir só pode rodar depois do commit');
    assert.ok(eventosDaConversa.length >= 2, 'deve publicar fila + mensagem');
    assert.ok(
      eventosDaConversa.every((e) => e.tenantId === TENANT_ID),
      'todo evento publicado pelo bot precisa do tenantId (gate SSE do FIL-64 é fail-closed)'
    );
  } finally {
    cancelar();
    distribuidor.atribuir = atribuirOriginal;
  }
});
