'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='111'; process.env.WA_BUSINESS_ACCOUNT_ID='999';
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const iaRuntime = require('../ia/runtime');
const { processPayload } = require('../webhook/processEvent');
const { invalidar: invalidarConfigCache } = require('../utils/configCache');

function payload(texto) {
  return { entry: [{ changes: [{ value: {
    metadata: { phone_number_id: '111' },
    contacts: [{ wa_id: '5562999990000', profile: { name: 'Gestor' } }],
    messages: [{ id: 'w.' + Math.random(), from: '5562999990000', timestamp: '1718000000', type: 'text', text: { body: texto } }],
  } }] }] };
}
function fakeConn(conversaExistente, opts) {
  const foraHorario = opts && opts.foraHorario;
  return { cap: [], async execute(sql, binds) {
    this.cap.push({ sql, binds });
    if (sql.includes('FROM numero')) return { rows: [{ ID: 2, TENANT_ID: 1, DEPARTAMENTO_PADRAO_ID: null, FLUXO_ID: null, MODO: 'ia' }] };
    if (sql.includes('FROM MC_ZAP_CONTATO')) return { rows: [{ ID: 3, NOME_PERFIL: 'Gestor' }] };
    if (sql.includes('FROM conversa')) return { rows: conversaExistente ? [conversaExistente] : [] };
    if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260701100001' }] };
    if (sql.startsWith('INSERT INTO conversa')) return { outBinds: { id: [88] } };
    if (sql.includes('FROM config')) {
      if (!foraHorario) return { rows: [] };
      return { rows: [
        { CHAVE: 'fora_horario_ativo', VALOR: 'S' },
        { CHAVE: 'horario_atendimento', VALOR: '{}' }, // nenhum dia configurado → sempre fora
        { CHAVE: 'fora_horario_msg', VALOR: 'Estamos fora do horário de atendimento.' },
      ] };
    }
    return { rows: [], outBinds: { id: [1] }, rowsAffected: 1 };
  }, commit: async()=>{}, rollback: async()=>{}, close: async()=>{} };
}
const aguardar = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('conversa nova em número MODO=ia entra em FILA_STATUS=ia e JÁ chama o runtime na 1ª msg', async () => {
  const conn = fakeConn(null); db.getConnection = async () => conn;
  // FIL-63: ia/runtime.processarEntrada passa a receber (tenantId, conversaId, texto).
  let chamado = null; iaRuntime.processarEntrada = async (tenantId, id, entrada) => { chamado = { tenantId, id, entrada }; };
  await processPayload(payload('vendas de ontem?'));
  await aguardar();
  const ins = conn.cap.find((c) => c.sql.startsWith('INSERT INTO conversa'));
  assert.equal(ins.binds.fst, 'ia');
  // A 1ª mensagem já é a pergunta — o runtime TEM que ser acionado (regressão:
  // antes exigia !conversa.criada e engolia a primeira mensagem, sem resposta).
  assert.equal(chamado && chamado.tenantId, 1);
  assert.equal(chamado && chamado.id, 88);
  assert.match(chamado.entrada.texto, /vendas/);
});

test('mensagem em conversa ia chama o runtime de IA', async () => {
  const conn = fakeConn({ ID: 88, DEPARTAMENTO_ID: null, FILA_STATUS: 'ia' }); db.getConnection = async () => conn;
  let chamado = null; iaRuntime.processarEntrada = async (tenantId, id, entrada) => { chamado = { tenantId, id, entrada }; };
  await processPayload(payload('inadimplência da filial 2'));
  await aguardar();
  assert.equal(chamado.tenantId, 1);
  assert.equal(chamado.id, 88);
  assert.match(chamado.entrada.texto, /inadimpl/);
});

test('conversa nova MODO=ia fora do horário de atendimento NÃO recebe aviso de fora de horário', async () => {
  invalidarConfigCache(); // força reler a config mockada (cache tem TTL de 60s)
  const conn = fakeConn(null, { foraHorario: true }); db.getConnection = async () => conn;
  iaRuntime.processarEntrada = async () => {}; // isola
  await processPayload(payload('vendas de ontem?'));
  await aguardar();

  // A conversa foi criada como 'ia' (MODO=ia no número).
  const ins = conn.cap.find((c) => c.sql.startsWith('INSERT INTO conversa'));
  assert.equal(ins.binds.fst, 'ia');

  // O guard de fora-de-horário nunca deve marcar/disparar para filaStatus='ia':
  // a marcação (AVISO_FORA_HORARIO='S') só acontece dentro do branch do aviso.
  const marcouAviso = conn.cap.some((c) => c.sql.includes("aviso_fora_horario = 'S'"));
  assert.equal(marcouAviso, false);
});

// FIL-84 — a IA deixou de receber só texto (obstáculo 7 do ticket).
test('áudio numa conversa de IA aciona o runtime com a entrada de áudio, não com silêncio', async () => {
  const conn = fakeConn({ ID: 88, DEPARTAMENTO_ID: null, FILA_STATUS: 'ia' }); db.getConnection = async () => conn;
  let chamado = null; iaRuntime.processarEntrada = async (tenantId, id, entrada) => { chamado = { tenantId, id, entrada }; };
  const p = payload('oi');
  p.entry[0].changes[0].value.messages[0] = {
    id: 'wamid.AUD1', from: '5562999990000', timestamp: '1718000000',
    type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg' },
  };
  await processPayload(p);
  await aguardar();
  assert.ok(chamado, 'o runtime tem que ser acionado — antes o áudio virava silêncio');
  // O download da mídia falha no ambiente de teste (sem Graph), então a
  // classificação cai em nao_suportado: o cliente recebe um pedido educado de
  // texto, que é exatamente o comportamento exigido.
  assert.ok(['audio', 'nao_suportado'].includes(chamado.entrada.tipo));
});

test('reação NÃO aciona o runtime da IA (não é pergunta)', async () => {
  const conn = fakeConn({ ID: 88, DEPARTAMENTO_ID: null, FILA_STATUS: 'ia' }); db.getConnection = async () => conn;
  let chamado = null; iaRuntime.processarEntrada = async (...a) => { chamado = a; };
  const p = payload('oi');
  p.entry[0].changes[0].value.messages[0] = {
    id: 'wamid.REACT1', from: '5562999990000', timestamp: '1718000000',
    type: 'reaction', reaction: { emoji: '👍' },
  };
  await processPayload(p);
  await aguardar();
  assert.equal(chamado, null, 'um emoji não pode custar uma chamada ao provedor');
});
