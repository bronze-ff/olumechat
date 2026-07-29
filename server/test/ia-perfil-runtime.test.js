'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';

// FIL-83 — o system prompt do bot vem do BANCO, por empresa.
//
// Regressão que estes testes seguram: até aqui o runtime dava readFileSync em
// CONHECIMENTO_DIR/system-prompt.md a cada mensagem, com fallback embutido
// ("assistente da Multicanal Atacado"). Como a pasta não existe no
// repositório, TODA empresa da plataforma respondia como a Multicanal.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plantado ANTES de carregar o runtime: se algum dia alguém reintroduzir a
// leitura de disco, este marcador aparece no prompt e o teste quebra.
const DIR_DISCO = fs.mkdtempSync(path.join(os.tmpdir(), 'fil83-'));
fs.writeFileSync(path.join(DIR_DISCO, 'system-prompt.md'), 'PROMPT-VINDO-DO-DISCO', 'utf8');
process.env.CONHECIMENTO_DIR = DIR_DISCO;

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const store = require('../ia/iaConfigStore');
const perfilStore = require('../ia/perfilStore');
const client = require('../ia/client');
const auth = require('../ia/autorizacao');
const runtime = require('../ia/runtime');

const TENANT = 93001;

function conn({ instrucoes = null, blocos = [] } = {}) {
  return {
    _ins: [],
    async execute(sql, binds = {}) {
      if (/^(SET|SELECT set_config|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql)) return { rows: [] };
      if (sql.includes('ia_habilitada')) return { rows: [{ IA_HABILITADA: 'S' }] };
      if (sql.includes('FROM conversa')) return { rows: [{ ID: 88, CONTATO_ID: 3, NUMERO_ID: 2, TELEFONE: '5562999990000', PHONE_NUMBER_ID: '111', FILA_STATUS: 'ia', IA_MODO_TESTE: 'S' }] };
      if (sql.includes('FROM ia_perfil')) return { rows: instrucoes === null ? [] : [{ INSTRUCOES: instrucoes, FICHA: { endereco: 'Rua das Flores, 100' } }] };
      if (sql.includes('FROM ia_conhecimento')) return { rows: blocos };
      if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 0 }] };
      if (sql.includes('FROM ia_turno')) return { rows: [] };
      this._ins.push({ sql, binds });
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('o prompt vem do BANCO (instruções + ficha + blocos ativos), nunca do disco', async () => {
  perfilStore.invalidar(TENANT);
  const c = conn({
    instrucoes: 'Você é a Ana, atendente da Pizzaria do Zé.',
    blocos: [{ TITULO: 'Cardápio', CONTEUDO: 'Margherita R$ 45' }],
  });
  db.getConnection = async () => c;
  auth.autorizado = async () => true;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  let sistema = null;
  client.chamar = async (a) => { sistema = a.sistema; return { texto: 'ok', toolCalls: [] }; };
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w' }] }) });

  await runtime.processarEntrada(TENANT, 88, 'oi');

  assert.ok(sistema, 'o provedor precisa ter sido chamado');
  assert.ok(sistema.includes('Pizzaria do Zé'), 'as instruções salvas pela empresa têm que estar no prompt');
  assert.ok(sistema.includes('Rua das Flores, 100'), 'a ficha da empresa tem que estar no prompt');
  assert.ok(sistema.includes('Margherita R$ 45'), 'os blocos ativos têm que estar no prompt');
  assert.ok(!sistema.includes('PROMPT-VINDO-DO-DISCO'), 'o prompt não pode mais vir de arquivo em disco');
  assert.ok(!/multicanal/i.test(sistema), 'nenhuma empresa pode receber o vocabulário da Multicanal');
});

test('empresa SEM perfil: o bot responde com a base neutra, não como a Multicanal', async () => {
  const SEM_PERFIL = 93002;
  perfilStore.invalidar(SEM_PERFIL);
  const c = conn();
  db.getConnection = async () => c;
  auth.autorizado = async () => true;
  store.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  let sistema = null;
  client.chamar = async (a) => { sistema = a.sistema; return { texto: 'ok', toolCalls: [] }; };
  global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w' }] }) });

  await runtime.processarEntrada(SEM_PERFIL, 88, 'oi');

  assert.ok(!/multicanal/i.test(sistema));
  assert.ok(sistema.includes(perfilStore.IDENTIDADE_NEUTRA));
  assert.ok(/nunca invente/i.test(sistema), 'a base anti-alucinação vale mesmo sem perfil configurado');
});

test('telefone não autorizado: o recado ao cliente final não cita empresa nenhuma', async () => {
  const OUTRO = 93003;
  perfilStore.invalidar(OUTRO);
  db.getConnection = async () => conn();
  auth.autorizado = async () => false;
  const enviados = [];
  global.fetch = async (u, o) => { enviados.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ messages: [{ id: 'w' }] }) }; };

  await runtime.processarEntrada(OUTRO, 88, 'oi');

  assert.equal(enviados.length, 1);
  const texto = enviados[0].text.body;
  assert.ok(!/multicanal/i.test(texto), 'esse texto chega ao cliente final de QUALQUER empresa da plataforma');
  assert.ok(!/\bTI\b/.test(texto));
  assert.ok(/restrito/i.test(texto));
});

test('runtime.js não tem mais leitura de arquivo nem fallback da Multicanal no código', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'ia', 'runtime.js'), 'utf8');
  assert.ok(!/require\(['"]node:fs['"]\)/.test(fonte), 'o prompt não pode voltar a ser lido do disco a cada mensagem');
  assert.ok(!fonte.includes('system-prompt.md'));
  assert.ok(!fonte.includes('SISTEMA_FALLBACK'));
  assert.ok(!/multicanal/i.test(fonte), 'o vocabulário da Multicanal não pode voltar ao caminho da IA');
});

test.after(() => { try { fs.rmSync(DIR_DISCO, { recursive: true, force: true }); } catch { /* tmp */ } });
