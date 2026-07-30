// FIL-77 — 2ª rodada de review do Codex (P2): "quando um cliente manda
// imagem/documento/áudio/vídeo/figurinha e safeDownload tem sucesso, os
// bytes são armazenados e midia_tamanho é persistido, mas só a rota de
// upload (atendente enviando pro cliente) emitia midia_armazenada — mídia
// RECEBIDA do cliente também ocupa armazenamento nosso e ficava de fora."
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';
process.env.DEV_META_FALLBACK = '1';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const presence = require('../realtime/presence');
const { processPayload } = require('../webhook/processEvent');
const storageModule = require('../storage');

function payloadImagem({ wamid = 'wamid.IMG1' } = {}) {
  return {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '1112223334', display_phone_number: '556237731090' },
          contacts: [{ wa_id: '5562999990000', profile: { name: 'Cliente' } }],
          messages: [{
            id: wamid, from: '5562999990000', timestamp: '1718000000', type: 'image',
            image: { id: 'media_abc123', mime_type: 'image/jpeg', sha256: 'deadbeef' },
          }],
        },
      }],
    }],
  };
}

function fakeConn({ conversaExistente = null, capturas = [] } = {}) {
  return {
    capturas,
    async execute(sql, binds) {
      capturas.push({ sql, binds });
      if (sql.includes('FROM numero')) {
        return { rows: [{ ID: 2, TENANT_ID: 701, DEPARTAMENTO_PADRAO_ID: null, MODO: 'padrao', FLUXO_ID: null }] };
      }
      if (sql.includes('NOME_PERFIL FROM contato')) return { rows: [{ ID: 3, NOME_PERFIL: 'Cliente' }] };
      if (sql.includes('FROM conversa')) return { rows: conversaExistente ? [conversaExistente] : [] };
      if (sql.includes("nextval('seq_protocolo')")) return { rows: [{ P: '260610100099' }] };
      if (sql.startsWith('INSERT INTO conversa')) return { outBinds: { id: [70] } };
      if (sql.startsWith('INSERT INTO mensagem')) return { rowsAffected: 1 }; // ON CONFLICT DO NOTHING → "inserida"
      return { rows: [], outBinds: {}, rowsAffected: 1 };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test.beforeEach(() => {
  presence._reset();
  // Evita gravar no disco de verdade — só interessa que downloadMedia
  // "funcionou" e devolveu os metadados (inclusive o tamanho).
  storageModule.storage.salvar = async () => {};
});

test('imagem recebida do cliente: safeDownload com sucesso grava midia_armazenada (tamanho real)', async () => {
  const capturas = [];
  db.getConnection = async () => fakeConn({ capturas });
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://graph.facebook.com')) {
      return { ok: true, json: async () => ({ url: 'https://scontent.fbcdn.net/media_abc123_bin', mime_type: 'image/jpeg', sha256: 'deadbeef', file_size: 54321 }) };
    }
    if (u.startsWith('https://scontent.fbcdn.net')) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(54321) };
    }
    throw new Error(`fetch inesperado: ${u}`);
  };

  await processPayload(payloadImagem());

  // A mesma mensagem também é uma conversa NOVA (FIL-76) — filtra por tipo
  // pra isolar só o evento de armazenamento de mídia.
  const evento = capturas.find((c) => /INSERT INTO consumo_evento/i.test(c.sql) && c.binds.tipo === 'midia_armazenada');
  assert.ok(evento, 'a mídia recebida deveria virar evento de consumo');
  assert.equal(evento.binds.qtd, 54321, 'quantidade = tamanho REAL devolvido pela Meta (file_size), nunca estimado');
  assert.equal(evento.binds.tenantId, 701);
});

test('imagem recebida mas download FALHA: não grava midia_armazenada (nada foi de fato armazenado)', async () => {
  const capturas = [];
  db.getConnection = async () => fakeConn({ capturas });
  global.fetch = async () => { throw new Error('rede fora do ar (simulado)'); };

  await assert.doesNotReject(processPayload(payloadImagem({ wamid: 'wamid.IMG2' })));

  // A conversa NOVA (FIL-76) ainda conta — só a mídia (que falhou) não.
  const eventos = capturas.filter((c) => /INSERT INTO consumo_evento/i.test(c.sql));
  assert.equal(eventos.filter((e) => e.binds.tipo === 'midia_armazenada').length, 0, 'download falhou — nada foi de fato armazenado');
  assert.equal(eventos.filter((e) => e.binds.tipo === 'conversa_iniciada').length, 1, 'a conversa em si nasceu mesmo com a mídia falhando');
  // A mensagem em si ainda é gravada (sem mídia) — safeDownload nunca perde a mensagem por causa da mídia.
  assert.ok(capturas.some((c) => c.sql.startsWith('INSERT INTO mensagem')));
});

test('REGRESSÃO (dedup): webhook REENTREGUE (mesmo WAMID) não conta a mesma mídia duas vezes', async () => {
  const capturas = [];
  // ON CONFLICT DO NOTHING: a 2ª tentativa do MESMO wamid não afeta linha nenhuma.
  let primeiraVez = true;
  const conn = fakeConn({ capturas });
  const originalExecute = conn.execute.bind(conn);
  conn.execute = async (sql, binds) => {
    if (sql.startsWith('INSERT INTO mensagem')) {
      const rowsAffected = primeiraVez ? 1 : 0;
      primeiraVez = false;
      capturas.push({ sql, binds });
      return { rowsAffected };
    }
    return originalExecute(sql, binds);
  };
  db.getConnection = async () => conn;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://graph.facebook.com')) {
      return { ok: true, json: async () => ({ url: 'https://scontent.fbcdn.net/media_abc123_bin', mime_type: 'image/jpeg', file_size: 999 }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(999) };
  };

  const payload = payloadImagem({ wamid: 'wamid.IMG3' });
  await processPayload(payload);
  await processPayload(payload); // reentrega do MESMO webhook

  // Filtra por midia_armazenada: o fake sempre devolve "conversa não existe"
  // (não modela persistência entre chamadas), então conversa_iniciada (FIL-76)
  // dispara em cada entrega neste teste — o que importa aqui é só a mídia.
  const eventos = capturas.filter((c) => /INSERT INTO consumo_evento/i.test(c.sql) && c.binds.tipo === 'midia_armazenada');
  assert.equal(eventos.length, 1, 'a reentrega não pode contar a mídia de novo');
});
