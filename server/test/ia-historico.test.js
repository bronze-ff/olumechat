'use strict';
const test = require('node:test');
const assert = require('node:assert');
const hist = require('../ia/historico');
const TENANT_A = 1;
const TENANT_B = 2;

test('carrega turnos em ordem e reconstrói o formato neutro', async () => {
  const conn = { async execute(sql) {
    if (sql.includes('SELECT')) return { rows: [
      { PAPEL: 'user', CONTEUDO: 'vendas junho', TOOL_JSON: null },
      { PAPEL: 'assistant', CONTEUDO: '', TOOL_JSON: JSON.stringify({ toolCallId: 't1', nome: 'consultar_vendas', args: { data_ini: '2026-06-01' } }) },
    ] };
    return { rows: [] };
  } };
  const msgs = await hist.carregar(conn, TENANT_A, 88);
  assert.equal(msgs[0].papel, 'user');
  assert.equal(msgs[1].toolCallId, 't1');
});

test('TOOL_JSON já vem como objeto (o driver pg decodifica jsonb sozinho)', async () => {
  const conn = { async execute() { return { rows: [
    { PAPEL: 'tool', CONTEUDO: '', TOOL_JSON: { toolCallId: 't2', nome: 'x', resultado: '[]' } },
  ] }; } };
  const msgs = await hist.carregar(conn, TENANT_A, 88);
  assert.equal(msgs[0].toolCallId, 't2');
});

test('salva incrementando o número do turno', async () => {
  const vistos = [];
  const conn = { async execute(sql, binds) {
    if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 2 }] };
    vistos.push({ sql, binds }); return { rows: [] };
  } };
  await hist.salvar(conn, TENANT_A, 88, 'user', { texto: 'oi' });
  const ins = vistos.find((v) => v.sql.includes('INSERT INTO ia_turno'));
  assert.equal(ins.binds.n, 3);
  assert.equal(ins.binds.papel, 'user');
  assert.equal(ins.binds.tenantId, TENANT_A);
});

test('carregar e salvar sempre filtram/gravam por tenant_id', async () => {
  const vistos = [];
  const conn = { async execute(sql, binds) {
    vistos.push({ sql, binds });
    if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 0 }] };
    return { rows: [] };
  } };
  await hist.carregar(conn, TENANT_A, 1);
  await hist.salvar(conn, TENANT_A, 1, 'user', { texto: 'oi' });
  assert.ok(vistos.every((v) => v.binds.tenantId === TENANT_A), 'toda query do módulo leva tenant_id');
});

test('SEGURANÇA: turno gravado pelo tenant A não aparece no histórico lido pelo tenant B', async () => {
  // Fake conn simula a RLS filtrando por tenant_id — se o módulo esquecesse de
  // mandar o tenantId no bind, este teste veria o turno do A "vazando" pro B.
  const linhas = [];
  const conn = {
    async execute(sql, binds) {
      if (sql.includes('MAX(NUMERO_TURNO)')) {
        const doTenant = linhas.filter((l) => l.tenant_id === binds.tenantId);
        return { rows: [{ N: doTenant.length }] };
      }
      if (sql.startsWith('INSERT INTO ia_turno')) {
        linhas.push({ tenant_id: binds.tenantId, conversa_id: binds.c, papel: binds.papel, conteudo: binds.conteudo });
        return { rows: [] };
      }
      const doTenant = linhas.filter((l) => l.tenant_id === binds.tenantId && l.conversa_id === binds.c);
      return { rows: doTenant.map((l) => ({ PAPEL: l.papel, CONTEUDO: l.conteudo, TOOL_JSON: null })) };
    },
  };
  await hist.salvar(conn, TENANT_A, 1, 'user', { texto: 'segredo do tenant A' });
  const vistoPeloB = await hist.carregar(conn, TENANT_B, 1);
  assert.deepEqual(vistoPeloB, [], 'tenant B enxergou o turno do tenant A — VAZAMENTO');
  const vistoPeloA = await hist.carregar(conn, TENANT_A, 1);
  assert.equal(vistoPeloA[0].texto, 'segredo do tenant A');
});

// ---------------------------------------------------------------------------
// FIL-84 — o turno passa a carregar o que chegou (mídia) e a marca de aviso.
// ---------------------------------------------------------------------------
test('salvar guarda o CAMINHO da mídia, nunca os bytes', async () => {
  const capturas = [];
  const conn = { async execute(sql, binds) {
    capturas.push({ sql, binds });
    if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 0 }] };
    return { rows: [] };
  } };
  await hist.salvar(conn, 1, 88, 'user', { texto: 'olha isso', midiaCaminho: '1/88/a.jpg', midiaMime: 'image/jpeg' });
  const ins = capturas.find((c) => /INSERT INTO ia_turno/i.test(c.sql));
  assert.equal(ins.binds.cam, '1/88/a.jpg');
  assert.equal(ins.binds.mime, 'image/jpeg');
  assert.ok(!/bytea|buffer/i.test(ins.sql), 'o turno não guarda binário');
});

test('carregar devolve midiaCaminho e midiaMime no turno', async () => {
  const conn = { async execute() {
    return { rows: [{ PAPEL: 'user', CONTEUDO: 'olha', TOOL_JSON: null, MIDIA_CAMINHO: '1/88/a.jpg', MIDIA_MIME: 'image/jpeg' }] };
  } };
  const msgs = await hist.carregar(conn, 1, 88);
  assert.equal(msgs[0].midiaCaminho, '1/88/a.jpg');
  assert.equal(msgs[0].midiaMime, 'image/jpeg');
});

test('turno de AVISO não vira tool-call ao recarregar (envenenaria o payload do provedor)', async () => {
  const conn = { async execute() {
    return { rows: [{ PAPEL: 'assistant', CONTEUDO: 'me manda por texto', TOOL_JSON: JSON.stringify({ aviso: 'video' }),
      MIDIA_CAMINHO: null, MIDIA_MIME: null }] };
  } };
  const msgs = await hist.carregar(conn, 1, 88);
  assert.equal(msgs[0].toolCallId, undefined, 'sem tool_use_id, o provedor rejeitaria o turno');
  assert.equal(msgs[0].texto, 'me manda por texto');
});

test('jaAvisou: a resposta educada de tipo não suportado sai UMA vez por conversa', async () => {
  let temMarca = false;
  const conn = { async execute(sql, binds) {
    if (/tool_json->>'aviso'/i.test(sql)) return { rows: temMarca ? [{ N: 1 }] : [] };
    if (sql.includes('MAX(NUMERO_TURNO)')) return { rows: [{ N: 0 }] };
    if (/INSERT INTO ia_turno/i.test(sql) && binds.tj && binds.tj.includes('"aviso"')) temMarca = true;
    return { rows: [] };
  } };
  assert.equal(await hist.jaAvisou(conn, 1, 88, 'video'), false);
  await hist.salvar(conn, 1, 88, 'assistant', { texto: 'me manda por texto', aviso: 'video' });
  assert.equal(await hist.jaAvisou(conn, 1, 88, 'video'), true);
});
