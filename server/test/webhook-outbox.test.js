// FIL-94 — achados P1-1 e P1-2 da review cruzada (Codex) do PR #40.
//
// Os dois furos ficavam ENTRE o commit do change e o dispatch dos efeitos:
//
//  P1-1  Commitar a mensagem e morrer antes de despachar. No replay, o dedup por
//        WAMID pulava a mensagem, nenhum efeito era produzido e o evento era
//        marcado `concluido`: o cliente ficava SEM RESPOSTA AUTOMÁTICA no
//        cenário-alvo do ticket ("matar após o ACK não perde nem duplica").
//
//  P1-2  O replay abria/renovava conversa e registrava `conversa_iniciada`
//        (cobrável!) ANTES de o insertInbound descobrir o WAMID duplicado —
//        rebobinando a janela de 24h de conversa aberta, ou criando conversa nova
//        vazia se a original já tinha sido resolvida.
//
// Aqui o pipeline REAL do processEvent roda contra um banco em memória que
// modela o que importa (dedup por wamid, persistência de conversa e o outbox
// `webhook_efeito`), com o eventoStore trocado por um dublê de estado — é a
// combinação que deixa o teste determinístico sem banco nem rede.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.GRAPH_VERSION = 'v21.0';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db/pool');
const presence = require('../realtime/presence');
const store = require('../webhook/eventoStore');
const efeitoStore = require('../webhook/efeitoStore');
const durabilidade = require('../webhook/durabilidade');
const botRuntime = require('../bot/runtime');

const TENANT = 501;
const FLUXO = 9;

function payload(wamid, texto = 'oi') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '9998887776',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '1112223334', display_phone_number: '556237731090' },
          contacts: [{ wa_id: '5562999990000', profile: { name: 'Cliente' } }],
          messages: [{ id: wamid, from: '5562999990000', timestamp: '1750000000', type: 'text', text: { body: texto } }],
        },
      }],
    }],
  };
}

/**
 * Banco em memória do lado do TENANT (o que o processChange e o efeitoStore
 * tocam). Modela só o essencial, mas modela de verdade: wamid já gravado,
 * conversa que persiste entre entregas e a tabela de efeitos.
 */
function bancoEmMemoria() {
  const estado = {
    wamids: new Set(),
    conversas: [],
    efeitos: [],
    capturas: [],
    seq: 100,
  };
  db.getConnection = async () => ({
    async execute(sql, binds = {}) {
      const t = String(sql).trim();
      estado.capturas.push({ sql: t, binds });

      if (/^SET\s+LOCAL\s+ROLE/i.test(t) || /set_config\(/i.test(t)) return { rows: [] };
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/i.test(t)) return { rows: [] };

      if (/FROM numero/i.test(t)) {
        return { rows: [{
          ID: 2, TENANT_ID: TENANT, DEPARTAMENTO_PADRAO_ID: null, MODO: 'padrao',
          IA_REGRA: 'sempre', IA_MODO_TESTE: 'N', FLUXO_ID: FLUXO,
        }] };
      }
      // Pré-check de dedup (P1-2): o que faz o replay não tocar em nada.
      if (/^SELECT wamid FROM mensagem/i.test(t)) {
        const alvos = Object.values(binds);
        return { rows: alvos.filter((w) => estado.wamids.has(w)).map((w) => ({ WAMID: w })) };
      }
      if (/NOME_PERFIL FROM contato/i.test(t)) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] };
      if (/^SELECT id, departamento_id, fila_status, protocolo, aviso_fora_horario FROM conversa/i.test(t)) {
        const abertas = estado.conversas.filter((c) => c.status !== 'resolvida');
        return { rows: abertas.map((c) => ({
          ID: c.id, DEPARTAMENTO_ID: c.departamentoId, FILA_STATUS: c.filaStatus,
          PROTOCOLO: c.protocolo, AVISO_FORA_HORARIO: 'N',
        })) };
      }
      if (/nextval\('seq_protocolo'\)/i.test(t)) return { rows: [{ P: '260610100042' }] };
      if (/^INSERT INTO conversa/i.test(t)) {
        const id = ++estado.seq;
        estado.conversas.push({
          id, status: 'aberta', departamentoId: binds.dep, filaStatus: binds.fst, protocolo: binds.prot,
        });
        return { outBinds: { id: [id] }, rowsAffected: 1 };
      }
      if (/^INSERT INTO mensagem/i.test(t)) {
        if (binds.wamid && estado.wamids.has(binds.wamid)) return { rowsAffected: 0 }; // ON CONFLICT DO NOTHING
        if (binds.wamid) estado.wamids.add(binds.wamid);
        return { rowsAffected: 1 };
      }
      if (/^INSERT INTO webhook_efeito/i.test(t)) {
        estado.efeitos.push({
          id: ++estado.seq, tenantId: TENANT, eventoId: binds.ev,
          tipo: binds.tipo, payload: binds.payload, despachadoEm: null,
        });
        return { rowsAffected: 1 };
      }
      if (/FROM webhook_efeito/i.test(t)) {
        const linhas = estado.efeitos
          .filter((e) => e.eventoId === binds.ev && e.despachadoEm === null)
          .map((e) => ({ ID: e.id, TENANT_ID: e.tenantId, TIPO: e.tipo, PAYLOAD: e.payload }));
        return { rows: linhas };
      }
      if (/^UPDATE webhook_efeito/i.test(t)) {
        const alvo = estado.efeitos.find((e) => e.id === binds.id && e.despachadoEm === null);
        if (!alvo) return { rows: [], rowsAffected: 0 };
        alvo.despachadoEm = Date.now();
        return { rows: [{ ID: alvo.id }], rowsAffected: 1 };
      }
      return { rows: [], outBinds: {}, rowsAffected: 1 };
    },
    async commit() {}, async rollback() {}, async close() {},
  });
  return estado;
}

/** Dublê do eventoStore com a semântica de estado do SQL, inclusive a guarda de
    conclusão: evento com efeito pendente NÃO conclui (é a regra do P1-1). */
function eventosEmMemoria(banco) {
  const eventos = new Map();
  let seq = 0;
  const pendente = (ev) => ev.estado === 'recebido' || ev.estado === 'processando';
  const temEfeitoPendente = (id) => banco.efeitos.some((e) => e.eventoId === id && e.despachadoEm === null);

  store.persistir = async ({ rawBody }) => {
    const id = ++seq;
    eventos.set(id, { id, payload: rawBody.toString('utf8'), estado: 'recebido', tentativas: 0, tentadoEm: null });
    return { id, duplicado: false };
  };
  store.reivindicarNovo = async (id) => {
    const ev = eventos.get(id);
    if (!ev || ev.estado !== 'recebido' || ev.tentativas !== 0) return false;
    ev.estado = 'processando'; ev.tentativas += 1; ev.tentadoEm = Date.now();
    return true;
  };
  store.reivindicarOrfao = async (id) => {
    const ev = eventos.get(id);
    if (!ev || !pendente(ev)) return false;
    ev.estado = 'processando'; ev.tentativas += 1; ev.tentadoEm = Date.now();
    return true;
  };
  store.concluir = async (id) => {
    const ev = eventos.get(id);
    if (!ev || temEfeitoPendente(id)) return { atrasoMs: null, concluido: false };
    ev.estado = 'concluido';
    return { atrasoMs: 5, concluido: true };
  };
  store.falhar = async (id, erro, max) => {
    const ev = eventos.get(id);
    if (!ev) return { estado: null, tentativas: null, definitivo: false };
    ev.estado = ev.tentativas >= max ? 'falhou' : 'recebido';
    return { estado: ev.estado, tentativas: ev.tentativas, definitivo: ev.estado === 'falhou' };
  };
  store.candidatosOrfaos = async ({ maxTentativas }) => [...eventos.values()]
    .filter((ev) => pendente(ev) && ev.tentativas < maxTentativas)
    .map((ev) => ({ id: ev.id, payload: ev.payload, tentativas: ev.tentativas }));
  store.finalizarEncalhados = async ({ maxTentativas }) => [...eventos.values()]
    .filter((ev) => pendente(ev) && ev.tentativas >= maxTentativas)
    .map((ev) => { ev.estado = 'falhou'; return ev.id; });
  store.pendentes = async () => ({
    total: [...eventos.values()].filter(pendente).length, maisAntigoSeg: 0,
    falhas: [...eventos.values()].filter((e) => e.estado === 'falhou').length,
  });
  store.purgarConcluidos = async () => 0;
  return eventos;
}

const ORIGINAIS = {
  store: { ...store },
  efeitoStore: { ...efeitoStore },
  getConnection: db.getConnection,
  iniciarFluxo: botRuntime.iniciarFluxo,
};

test.beforeEach(() => presence._reset());
test.afterEach(() => {
  Object.assign(store, ORIGINAIS.store);
  Object.assign(efeitoStore, ORIGINAIS.efeitoStore);
  db.getConnection = ORIGINAIS.getConnection;
  botRuntime.iniciarFluxo = ORIGINAIS.iniciarFluxo;
  durabilidade.parar();
  durabilidade.zerarMetricas();
});

// ===================== P1-1 =====================
test('P1-1: morte entre o commit e o dispatch — a recuperação despacha o efeito e o cliente é atendido', async () => {
  const banco = bancoEmMemoria();
  const eventos = eventosEmMemoria(banco);
  const saudacoes = [];
  botRuntime.iniciarFluxo = (tenantId, conversaId) => saudacoes.push({ tenantId, conversaId });

  const bruto = Buffer.from(JSON.stringify(payload('wamid.P1')));
  const { id } = await durabilidade.receber(bruto, payload('wamid.P1'));

  // Falha DEPOIS do commit do change e ANTES do dispatch (processo morto ou
  // leitura do outbox indisponível): nada é despachado, mas a mensagem do
  // cliente e os efeitos dela já estão gravados.
  efeitoStore.pendentes = async () => { throw new Error('dispatch não aconteceu'); };
  await durabilidade.processar(id, payload('wamid.P1'));

  assert.equal(banco.wamids.has('wamid.P1'), true, 'a mensagem do cliente commitou');
  assert.ok(banco.efeitos.length >= 1, 'os efeitos pós-commit precisam ter commitado JUNTO com a mensagem');
  assert.equal(saudacoes.length, 0, 'nada foi despachado ainda (é a morte simulada)');
  assert.notEqual(eventos.get(id).estado, 'concluido', 'evento com efeito pendente não pode ser dado como concluído');

  // Processo novo sobe e roda a recuperação.
  Object.assign(efeitoStore, { pendentes: ORIGINAIS.efeitoStore.pendentes });
  await durabilidade.varrer();

  assert.deepEqual(saudacoes, [{ tenantId: TENANT, conversaId: 101 }],
    'o efeito pós-commit tem que ser despachado no replay — senão o cliente fica sem resposta automática');
  assert.equal(eventos.get(id).estado, 'concluido');
  assert.equal(banco.efeitos.every((e) => e.despachadoEm !== null), true, 'todo efeito despachado fica marcado');

  // Tick seguinte não repete o efeito.
  await durabilidade.varrer();
  assert.equal(saudacoes.length, 1, 'efeito marcado não pode ser despachado de novo');
});

test('P1-1: replay NÃO reproduz efeito já despachado (não duplica a saudação)', async () => {
  const banco = bancoEmMemoria();
  const eventos = eventosEmMemoria(banco);
  const saudacoes = [];
  botRuntime.iniciarFluxo = (tenantId, conversaId) => saudacoes.push({ tenantId, conversaId });

  const p = payload('wamid.P2');
  const { id } = await durabilidade.receber(Buffer.from(JSON.stringify(p)), p);
  await durabilidade.processar(id, p);
  assert.equal(saudacoes.length, 1);
  assert.equal(eventos.get(id).estado, 'concluido');

  // Reprocessamento forçado do MESMO evento (ex.: conclusão não gravada e a
  // varredura pegou de novo): nem efeito novo, nem efeito repetido.
  eventos.get(id).estado = 'processando';
  await durabilidade.varrer();
  assert.equal(saudacoes.length, 1, 'reprocessar não pode redisparar efeito já despachado');
});

// ===================== P1-2 =====================
test('P1-2: replay de payload já commitado não muta conversa nem consumo', async () => {
  const banco = bancoEmMemoria();
  const eventos = eventosEmMemoria(banco);
  botRuntime.iniciarFluxo = () => {};

  const p = payload('wamid.P3');
  const bruto = Buffer.from(JSON.stringify(p));
  const primeiro = await durabilidade.receber(bruto, p);
  await durabilidade.processar(primeiro.id, p);

  const daPrimeira = {
    conversas: banco.conversas.length,
    efeitos: banco.efeitos.length,
  };
  banco.capturas.length = 0; // só o que o REPLAY fizer

  // Replay do mesmo evento (o cenário do restart).
  eventos.get(primeiro.id).estado = 'recebido';
  eventos.get(primeiro.id).tentativas = 0;
  await durabilidade.varrer();

  const escritas = banco.capturas.filter((c) => /^(INSERT|UPDATE)/i.test(c.sql));
  const mexeuEmConversa = escritas.filter((c) => /conversa/i.test(c.sql));
  const mexeuEmConsumo = escritas.filter((c) => /consumo_evento/i.test(c.sql));
  const mexeuEmMensagem = escritas.filter((c) => /INSERT INTO mensagem/i.test(c.sql));

  assert.deepEqual(mexeuEmConversa, [], 'replay abriu/renovou conversa — rebobina a janela de 24h do cliente');
  assert.deepEqual(mexeuEmConsumo, [], 'replay contou conversa_iniciada de novo — isso é cobrança em dobro');
  assert.deepEqual(mexeuEmMensagem, [], 'replay nem deve tentar inserir mensagem já gravada');
  assert.equal(banco.conversas.length, daPrimeira.conversas, 'nenhuma conversa nova');
  assert.equal(banco.efeitos.length, daPrimeira.efeitos, 'nenhum efeito duplicado no outbox');
});

test('P1-2: payload PARCIALMENTE gravado — a mensagem que faltou é processada normalmente', async () => {
  const banco = bancoEmMemoria();
  eventosEmMemoria(banco);
  botRuntime.iniciarFluxo = () => {};

  // A primeira mensagem já entrou numa entrega anterior; a segunda, não.
  banco.wamids.add('wamid.JA');
  const p = payload('wamid.JA');
  p.entry[0].changes[0].value.messages.push({
    id: 'wamid.NOVA', from: '5562999990000', timestamp: '1750000001', type: 'text', text: { body: 'segunda' },
  });

  const { id } = await durabilidade.receber(Buffer.from(JSON.stringify(p)), p);
  await durabilidade.processar(id, p);

  const inseridas = banco.capturas
    .filter((c) => /^INSERT INTO mensagem/i.test(c.sql))
    .map((c) => c.binds.wamid);
  assert.deepEqual(inseridas, ['wamid.NOVA'],
    'o pré-check é por MENSAGEM: a que faltava tem que ser gravada, a que existia não pode ser tocada');
  assert.equal(banco.wamids.has('wamid.NOVA'), true);
});

// ===================== P2-3 =====================
test('P2-3: falha transitória na finalização no último attempt não encalha o evento', async () => {
  process.env.WEBHOOK_MAX_TENTATIVAS = '1';
  const banco = bancoEmMemoria();
  const eventos = eventosEmMemoria(banco);
  botRuntime.iniciarFluxo = () => {};
  try {
    const p = payload('wamid.P4');
    const { id } = await durabilidade.receber(Buffer.from(JSON.stringify(p)), p);

    // Último attempt: o processamento vai bem, mas o UPDATE de conclusão cai.
    const concluirOriginal = store.concluir;
    store.concluir = async () => { throw new Error('conexão caiu no COMMIT'); };
    await durabilidade.processar(id, p);
    store.concluir = concluirOriginal;

    const encalhado = eventos.get(id);
    assert.equal(encalhado.estado, 'processando');
    assert.equal(encalhado.tentativas, 1, 'já está no teto: candidatosOrfaos (tentativas < max) não pega mais');

    // Sem o segundo passe da varredura, este evento ficaria pendente PARA SEMPRE.
    await durabilidade.varrer();
    assert.equal(eventos.get(id).estado, 'falhou', 'evento no teto de tentativas precisa terminar em falha definitiva');
    assert.equal(durabilidade.metricas().encalhados, 1);
    assert.equal(durabilidade.metricas().pendentes, 0, 'nada pode ficar pendente sem dono');
  } finally {
    delete process.env.WEBHOOK_MAX_TENTATIVAS;
  }
});

test('P2-3: efeito já commitado ainda é despachado quando o evento é finalizado como falhou', async () => {
  process.env.WEBHOOK_MAX_TENTATIVAS = '1';
  const banco = bancoEmMemoria();
  const eventos = eventosEmMemoria(banco);
  const saudacoes = [];
  botRuntime.iniciarFluxo = (tenantId, conversaId) => saudacoes.push({ tenantId, conversaId });
  try {
    const p = payload('wamid.P5');
    const { id } = await durabilidade.receber(Buffer.from(JSON.stringify(p)), p);

    // Commitou o change (efeitos no outbox) e o processo foi MORTO antes de
    // despachar, no último attempt disponível. Morte não deixa escrituração
    // nenhuma: nada de `falhar()`, nada de tentativa registrada depois do
    // commit — a linha fica em `processando` com as tentativas no teto.
    efeitoStore.pendentes = async () => { throw new Error('processo morto antes do dispatch'); };
    const falharOriginal = store.falhar;
    store.falhar = async () => ({ estado: 'processando', tentativas: 1, definitivo: false });
    await durabilidade.processar(id, p);
    Object.assign(efeitoStore, { pendentes: ORIGINAIS.efeitoStore.pendentes });
    store.falhar = falharOriginal;
    assert.equal(eventos.get(id).estado, 'processando');
    assert.equal(saudacoes.length, 0);

    await durabilidade.varrer();
    assert.equal(eventos.get(id).estado, 'falhou');
    assert.equal(saudacoes.length, 1,
      'efeito commitado é fato do cliente: sai mesmo com o evento condenado por tentativas');
  } finally {
    delete process.env.WEBHOOK_MAX_TENTATIVAS;
  }
});
