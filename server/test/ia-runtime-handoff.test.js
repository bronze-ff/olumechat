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

test('CORRIDA: atendente assume DURANTE a chamada ao provedor → resposta DESCARTADA', async () => {
  // fila_status: 'ia' na fase 1, 'ia' na entrada da fase 3 … e 'em_atendimento'
  // na recheca imediatamente anterior ao envio (a chamada ao provedor leva até
  // 45s — é a janela que sobra depois do fix P1 da review).
  const conn = connComFila(['ia', 'ia', 'em_atendimento']); db.getConnection = async () => conn;
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

// Achado de review (P1, PR #32): a recheca só antes do envio final deixava
// passar as respostas ENLATADAS da fase 3 (provedor não configurado, tipo não
// suportado, áudio sem transcrição). Entre a fase 1 e a fase 3 correm a
// resolução da credencial e o STT — segundos de rede em que o atendente pode
// assumir. Agora a fase 3 recheca logo na entrada.
test('CORRIDA: atendente assume durante o STT → nem a resposta enlatada sai', async () => {
  const conn = connComFila(['ia', 'em_atendimento']); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  let chamouModelo = false; client.chamar = async () => { chamouModelo = true; return { texto: 'x', toolCalls: [] }; };

  const sttMod = require('../ia/stt');
  const original = sttMod.transcreverEntrada;
  sttMod.transcreverEntrada = async () => ({ ok: false, motivo: 'sem_credencial' });
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) }; };

  try {
    await runtime.processarEntrada(TENANT, 88, {
      tipo: 'audio', texto: '', midiaCaminho: '1/88/a.ogg', mime: 'audio/ogg', tamanho: 2000, tipoOriginal: 'audio',
    });
  } finally { sttMod.transcreverEntrada = original; }

  assert.equal(enviados.length, 0, 'o "me manda por texto" saiu por cima do atendente que já assumiu');
  assert.equal(chamouModelo, false);
  assert.ok(!conn._ins.some((i) => /INSERT INTO ia_turno/i.test(i.sql)),
    'sem turno: o modelo nem chegou a ser consultado');
});

test('a resposta gated da fase 1 (canal restrito) TAMBÉM publica no tempo real', async () => {
  // Achado de review (P2): esses ramos respondem e saem com `return null`, e o
  // dreno de efeitos ficava depois do `if (!cv) return` — a mensagem saía pelo
  // WhatsApp e não aparecia na tela do atendente até o polling de 60s.
  const conn = connComFila(['ia']);
  conn.execute = (function (base) {
    return async function (sql, binds) {
      if (sql.includes('FROM conversa') && !/SELECT fila_status/i.test(sql)) {
        return { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000',
          PHONE_NUMBER_ID: '111', FILA_STATUS: 'ia', IA_MODO_TESTE: 'S' }] };
      }
      return base.call(this, sql, binds);
    };
  })(conn.execute);
  db.getConnection = async () => conn;
  auth.autorizado = async () => false;
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) }; };

  const eventos = [];
  const cancelar = subscribe((e) => eventos.push(e));
  try {
    await runtime.processarEntrada(TENANT, 88, 'oi');
  } finally { cancelar(); }

  assert.equal(enviados.length, 1, 'o recado de canal restrito sai');
  assert.ok(eventos.some((e) => e.tipo === 'mensagem' && e.conversaId === 88),
    'e tem que aparecer ao vivo, como qualquer outra mensagem enviada');
});

test('commit que FALHA não publica efeito nenhum (SSE de estado inexistente)', async () => {
  // Achado de review (P2): o dreno rodava depois do catch, então os efeitos de
  // uma transação que sofreu ROLLBACK eram publicados mesmo assim.
  const conn = connComFila(['ia', 'ia', 'ia']);
  conn.commit = async () => { throw new Error('commit falhou'); };
  db.getConnection = async () => conn;
  prepararProvedor();
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) });

  const eventos = [];
  const cancelar = subscribe((e) => eventos.push(e));
  try {
    await runtime.processarEntrada(TENANT, 88, 'oi');
  } finally { cancelar(); }

  assert.equal(eventos.length, 0, 'publicou um estado que sofreu rollback');
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

// ---------------------------------------------------------------------------
// FIL-84 — nunca silêncio (obstáculo 7 do ticket).
// ---------------------------------------------------------------------------
test('vídeo: a IA responde pedindo texto, sem gastar token do provedor', async () => {
  const conn = connComFila(['ia', 'ia']); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  let chamouModelo = false; client.chamar = async () => { chamouModelo = true; return { texto: '', toolCalls: [] }; };
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };

  await runtime.processarEntrada(TENANT, 88, { tipo: 'nao_suportado', texto: '', tipoOriginal: 'video' });

  assert.equal(chamouModelo, false, 'não pode gastar token para dizer "me manda por texto"');
  assert.equal(enviados.length, 1, 'silêncio é o pior resultado possível');
  assert.match(enviados[0].text.body, /texto/i);
});

test('entrada "ignorar" (reação, evento de sistema) não acorda a IA', async () => {
  const conn = connComFila(['ia']); db.getConnection = async () => conn;
  let abriuConexao = false;
  const original = db.getConnection;
  db.getConnection = async () => { abriuConexao = true; return original(); };
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(TENANT, 88, { tipo: 'ignorar' });
  assert.equal(enviados.length, 0);
  assert.equal(abriuConexao, false, 'nem chega a abrir conexão do pool');
});

test('compatibilidade: string continua valendo como entrada de texto', async () => {
  const conn = connComFila(['ia', 'ia']); db.getConnection = async () => conn;
  prepararProvedor('ok');
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };
  await runtime.processarEntrada(TENANT, 88, 'oi');
  assert.equal(enviados.length, 1);
  const turno = conn._ins.find((i) => /INSERT INTO ia_turno/i.test(i.sql) && i.binds.papel === 'user');
  assert.equal(turno.binds.conteudo, 'oi');
});

// ---------------------------------------------------------------------------
// FIL-84 — áudio de ponta a ponta.
// ---------------------------------------------------------------------------
test('áudio: transcreve, marca o turno e registra o consumo em segundos', async () => {
  const conn = connComFila(['ia', 'ia']); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  client.chamar = async () => ({ texto: 'Já te mando a segunda via.', toolCalls: [] });

  const stt = require('../ia/stt');
  const original = stt.transcreverEntrada;
  stt.transcreverEntrada = async () => ({ ok: true, texto: 'quero a segunda via do boleto', segundos: 7.4 });
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };

  try {
    await runtime.processarEntrada(TENANT, 88, {
      tipo: 'audio', texto: '', midiaCaminho: '1/88/a.ogg', mime: 'audio/ogg', tamanho: 20000, tipoOriginal: 'audio',
    });
  } finally { stt.transcreverEntrada = original; }

  const turno = conn._ins.find((i) => /INSERT INTO ia_turno/i.test(i.sql) && i.binds.papel === 'user');
  assert.match(turno.binds.conteudo, /\[áudio transcrito\]/, 'a transcrição tem que ficar marcada no histórico');
  assert.match(turno.binds.conteudo, /segunda via do boleto/);
  assert.equal(turno.binds.cam, '1/88/a.ogg', 'o turno guarda o caminho, não os bytes');
  const evtConsumo = conn._ins.find((i) => /INSERT INTO consumo_evento/i.test(i.sql) && i.binds.tipo === 'ia_audio_seg');
  assert.ok(evtConsumo, 'o STT tem que ser medido');
  assert.equal(evtConsumo.binds.qtd, 8, 'segundos arredondados para cima');
  assert.ok(enviados.some((e) => /segunda via/i.test(e.text.body)), 'a IA responde normalmente');
});

test('áudio sem credencial OpenAI: pede texto e não chama o modelo de chat', async () => {
  const conn = connComFila(['ia', 'ia']); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  let chamouChat = false; client.chamar = async () => { chamouChat = true; return { texto: 'x', toolCalls: [] }; };

  const stt = require('../ia/stt');
  const original = stt.transcreverEntrada;
  stt.transcreverEntrada = async () => ({ ok: false, motivo: 'sem_credencial' });
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };

  try {
    await runtime.processarEntrada(TENANT, 88, {
      tipo: 'audio', texto: '', midiaCaminho: '1/88/a.ogg', mime: 'audio/ogg', tamanho: 2000, tipoOriginal: 'audio',
    });
  } finally { stt.transcreverEntrada = original; }

  assert.equal(chamouChat, false, 'sem transcrição não há o que perguntar ao modelo');
  assert.equal(enviados.length, 1, 'nunca silêncio');
  assert.match(enviados[0].text.body, /escrever/i);
});

// ---------------------------------------------------------------------------
// FIL-84 — imagem de ponta a ponta.
// ---------------------------------------------------------------------------
test('imagem: o turno guarda o caminho e o provedor recebe os bytes', async () => {
  const conn = connComFila(['ia', 'ia']);
  const turnos = [];
  const executeBase = conn.execute.bind(conn);
  conn.execute = async (sql, binds) => {
    if (/INSERT INTO ia_turno/i.test(sql)) {
      turnos.push(binds);
      conn._ins.push({ sql, binds });
      return { rows: [] };
    }
    if (/SELECT PAPEL, CONTEUDO/i.test(sql)) {
      return { rows: turnos.map((t) => ({ PAPEL: t.papel, CONTEUDO: t.conteudo, TOOL_JSON: t.tj,
        MIDIA_CAMINHO: t.cam, MIDIA_MIME: t.mime })) };
    }
    return executeBase(sql, binds);
  };
  db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;

  const { storage } = require('../storage');
  const lerOriginal = storage.ler;
  storage.ler = async () => Buffer.from('ABC');

  let recebidas = null;
  client.chamar = async ({ mensagens }) => { recebidas = mensagens; return { texto: 'Recebi a foto!', toolCalls: [] }; };
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w' }] }) });

  try {
    await runtime.processarEntrada(TENANT, 88, {
      tipo: 'imagem', texto: 'olha o defeito', midiaCaminho: '1/88/a.jpg', mime: 'image/jpeg',
      tamanho: 1000, tipoOriginal: 'image',
    });
  } finally { storage.ler = lerOriginal; }

  const turnoUser = turnos.find((t) => t.papel === 'user');
  assert.equal(turnoUser.cam, '1/88/a.jpg', 'o turno guarda o caminho, nunca os bytes');
  assert.equal(turnoUser.mime, 'image/jpeg');
  const comImagem = (recebidas || []).filter((m) => m.imagem);
  assert.equal(comImagem.length, 1, 'a imagem tem que chegar ao provedor');
  assert.equal(comImagem[0].imagem.base64, Buffer.from('ABC').toString('base64'));
});

// Achado de review (P2, PR #32): o marcador `jaAvisou` era gravado ANTES do
// envio. Uma falha transitória no envio (Meta fora do ar, 500 momentâneo)
// deixava o marcador true e TODAS as mensagens seguintes daquele tipo passavam
// em silêncio — o oposto do "nunca silêncio" que o aviso existe para garantir.
test('aviso de tipo não suportado: envio que FALHA não grava o marcador (tenta de novo depois)', async () => {
  const conn = connComFila(['ia', 'ia']); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  // sendText lança → responder() grava status 'falha' e devolve 0.
  global.fetch = async () => { throw new Error('Meta fora do ar'); };

  await runtime.processarEntrada(TENANT, 88, { tipo: 'nao_suportado', texto: '', tipoOriginal: 'video' });

  const marcador = conn._ins.find((i) => /INSERT INTO ia_turno/i.test(i.sql)
    && i.binds.tj && i.binds.tj.includes('"aviso"'));
  assert.equal(marcador, undefined,
    'sem envio confirmado, o marcador não pode existir — senão o cliente nunca mais é avisado');
});

test('aviso de tipo não suportado: envio OK grava o marcador (não repete a cada vídeo)', async () => {
  const conn = connComFila(['ia', 'ia']); db.getConnection = async () => conn;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  auth.autorizado = async () => true;
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) });

  await runtime.processarEntrada(TENANT, 88, { tipo: 'nao_suportado', texto: '', tipoOriginal: 'video' });

  const marcador = conn._ins.find((i) => /INSERT INTO ia_turno/i.test(i.sql)
    && i.binds.tj && i.binds.tj.includes('"aviso"'));
  assert.ok(marcador, 'com envio confirmado, o marcador tem que ficar');
  assert.match(marcador.binds.tj, /video/);
});
