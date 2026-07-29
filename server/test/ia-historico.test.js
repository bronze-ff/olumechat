'use strict';
const test = require('node:test');
const assert = require('node:assert');
const hist = require('../ia/historico');
const TENANT_A = 1;
const TENANT_B = 2;

/** Conexão falsa. A ORDEM das checagens importa: desde a FIL-85 o próprio
 *  INSERT carrega o `MAX(NUMERO_TURNO)` numa subconsulta, então quem casar
 *  "MAX(NUMERO_TURNO)" antes de "INSERT" nunca vê a escrita acontecer. */
function fake({ rows = [], aoInserir = null, rowsAffected = 1 } = {}) {
  const executadas = [];
  return {
    executadas,
    async execute(sql, binds = {}) {
      executadas.push({ sql, binds });
      if (/^INSERT INTO ia_turno/i.test(sql.trim())) {
        if (aoInserir) aoInserir(binds);
        return { rows: [], rowsAffected };
      }
      return { rows: typeof rows === 'function' ? rows(binds) : rows };
    },
  };
}

test('carrega turnos em ordem e reconstrói o formato neutro', async () => {
  const conn = fake({ rows: [
    { PAPEL: 'user', CONTEUDO: 'vendas junho', TOOL_JSON: null },
    { PAPEL: 'assistant', CONTEUDO: '', TOOL_JSON: JSON.stringify({ toolCallId: 't1', nome: 'consultar_vendas', args: { data_ini: '2026-06-01' } }) },
    { PAPEL: 'tool', CONTEUDO: '', TOOL_JSON: JSON.stringify({ toolCallId: 't1', nome: 'consultar_vendas', resultado: '[]' }) },
  ] });
  const msgs = await hist.carregar(conn, TENANT_A, 88);
  assert.equal(msgs[0].papel, 'user');
  assert.equal(msgs[1].toolCallId, 't1');
});

test('TOOL_JSON já vem como objeto (o driver pg decodifica jsonb sozinho)', async () => {
  const conn = fake({ rows: [
    { PAPEL: 'user', CONTEUDO: 'oi', TOOL_JSON: null },
    { PAPEL: 'assistant', CONTEUDO: '', TOOL_JSON: { toolCallId: 't2', nome: 'x' } },
    { PAPEL: 'tool', CONTEUDO: '', TOOL_JSON: { toolCallId: 't2', nome: 'x', resultado: '[]' } },
  ] });
  const msgs = await hist.carregar(conn, TENANT_A, 88);
  assert.equal(msgs[2].toolCallId, 't2');
});

// ---------------------------------------------------------------------------
// FIL-85 — número do turno sem read-then-insert
// ---------------------------------------------------------------------------
test('salvar NÃO lê o MAX antes: o número sai na própria subconsulta do INSERT', async () => {
  const conn = fake();
  await hist.salvar(conn, TENANT_A, 88, 'user', { texto: 'oi' });

  assert.equal(conn.executadas.length, 1, 'duas idas ao banco é exatamente a corrida que o ticket removeu');
  const ins = conn.executadas[0];
  assert.match(ins.sql, /^INSERT INTO ia_turno/i);
  assert.match(ins.sql, /COALESCE\(MAX\(NUMERO_TURNO\), 0\) \+ 1/i, 'o número tem que ser calculado no INSERT');
  assert.match(ins.sql, /ON CONFLICT DO NOTHING/i, 'sem isto a corrida vira erro e aborta a transação do turno');
  assert.equal(ins.binds.papel, 'user');
  assert.equal(ins.binds.tenantId, TENANT_A);
});

test('perder a corrida (0 linhas afetadas) faz o INSERT tentar de novo', async () => {
  let tentativas = 0;
  const conn = {
    async execute() {
      tentativas += 1;
      // Perde as duas primeiras (outro turno gravou o mesmo número), ganha na 3ª.
      return { rows: [], rowsAffected: tentativas < 3 ? 0 : 1 };
    },
  };
  await hist.salvar(conn, TENANT_A, 88, 'assistant', { texto: 'resposta' });
  assert.equal(tentativas, 3, 'sem retry, o turno perdido some do histórico');
});

test('corrida sem fim não derruba o atendimento (desiste e loga)', async () => {
  const conn = { async execute() { return { rows: [], rowsAffected: 0 }; } };
  const erroOriginal = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  try {
    await hist.salvar(conn, TENANT_A, 88, 'user', { texto: 'oi' });
  } finally { console.error = erroOriginal; }
  assert.ok(logs.some((l) => /não consegui gravar o turno/i.test(l)));
});

// ---------------------------------------------------------------------------
// FIL-85 — janela de histórico
// ---------------------------------------------------------------------------
test('carregar pede só os últimos MAX_TURNOS, do fim para o começo', async () => {
  const conn = fake({ rows: [] });
  await hist.carregar(conn, TENANT_A, 88);
  const sel = conn.executadas[0];
  assert.equal(sel.binds.limite, hist.MAX_TURNOS);
  assert.equal(hist.MAX_TURNOS, 40, 'a spec fixa a janela em 40 turnos');
  assert.match(sel.sql, /ORDER BY NUMERO_TURNO DESC, ID DESC/i, 'a janela é pega pelo FIM da conversa');
  assert.match(sel.sql, /\) ultimos ORDER BY NUMERO_TURNO, ID/i, 'e devolvida na ordem cronológica');
});

test('a janela NUNCA começa num resultado de ferramenta órfão (o provedor daria 400)', async () => {
  // Recorte que cai no meio de um par: o `tool` de abertura perdeu a chamada
  // que o originou. Mandar isso à Anthropic/OpenAI é 400 — e 400 vira, para o
  // cliente, a resposta genérica de indisponível.
  const conn = fake({ rows: [
    { PAPEL: 'tool', CONTEUDO: '', TOOL_JSON: { toolCallId: 'orfao', nome: 'x', resultado: '[]' } },
    { PAPEL: 'assistant', CONTEUDO: 'tudo certo', TOOL_JSON: null },
    { PAPEL: 'user', CONTEUDO: 'obrigado', TOOL_JSON: null },
  ] });
  const msgs = await hist.carregar(conn, TENANT_A, 88);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].texto, 'tudo certo');
});

test('chamada de ferramenta sem resultado no fim também é aparada', async () => {
  // Só acontece se o processo morrer entre gravar a chamada e gravar o retorno.
  const conn = fake({ rows: [
    { PAPEL: 'user', CONTEUDO: 'quanto custa?', TOOL_JSON: null },
    { PAPEL: 'assistant', CONTEUDO: '', TOOL_JSON: { toolCallId: 'pendente', nome: 'consultar' } },
  ] });
  const msgs = await hist.carregar(conn, TENANT_A, 88);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].papel, 'user');
});

test('carregar e salvar sempre filtram/gravam por tenant_id', async () => {
  const conn = fake({ rows: [] });
  await hist.carregar(conn, TENANT_A, 1);
  await hist.salvar(conn, TENANT_A, 1, 'user', { texto: 'oi' });
  assert.ok(conn.executadas.every((v) => v.binds.tenantId === TENANT_A), 'toda query do módulo leva tenant_id');
});

test('SEGURANÇA: turno gravado pelo tenant A não aparece no histórico lido pelo tenant B', async () => {
  // Fake conn simula a RLS filtrando por tenant_id — se o módulo esquecesse de
  // mandar o tenantId no bind, este teste veria o turno do A "vazando" pro B.
  const linhas = [];
  const conn = {
    async execute(sql, binds) {
      if (/^INSERT INTO ia_turno/i.test(sql.trim())) {
        linhas.push({ tenant_id: binds.tenantId, conversa_id: binds.c, papel: binds.papel, conteudo: binds.conteudo });
        return { rows: [], rowsAffected: 1 };
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
  const conn = fake();
  await hist.salvar(conn, 1, 88, 'user', { texto: 'olha isso', midiaCaminho: '1/88/a.jpg', midiaMime: 'image/jpeg' });
  const ins = conn.executadas.find((c) => /INSERT INTO ia_turno/i.test(c.sql));
  assert.equal(ins.binds.cam, '1/88/a.jpg');
  assert.equal(ins.binds.mime, 'image/jpeg');
  assert.ok(!/bytea|buffer/i.test(ins.sql), 'o turno não guarda binário');
});

test('carregar devolve midiaCaminho e midiaMime no turno', async () => {
  const conn = fake({ rows: [{ PAPEL: 'user', CONTEUDO: 'olha', TOOL_JSON: null, MIDIA_CAMINHO: '1/88/a.jpg', MIDIA_MIME: 'image/jpeg' }] });
  const msgs = await hist.carregar(conn, 1, 88);
  assert.equal(msgs[0].midiaCaminho, '1/88/a.jpg');
  assert.equal(msgs[0].midiaMime, 'image/jpeg');
});

test('turno de AVISO não vira tool-call ao recarregar (envenenaria o payload do provedor)', async () => {
  const conn = fake({ rows: [{ PAPEL: 'assistant', CONTEUDO: 'me manda por texto', TOOL_JSON: JSON.stringify({ aviso: 'video' }),
    MIDIA_CAMINHO: null, MIDIA_MIME: null }] });
  const msgs = await hist.carregar(conn, 1, 88);
  assert.equal(msgs[0].toolCallId, undefined, 'sem tool_use_id, o provedor rejeitaria o turno');
  assert.equal(msgs[0].texto, 'me manda por texto');
});

test('jaAvisou: a resposta educada de tipo não suportado sai UMA vez por conversa', async () => {
  let temMarca = false;
  const conn = {
    async execute(sql, binds) {
      if (/^INSERT INTO ia_turno/i.test(sql.trim())) {
        if (binds.tj && binds.tj.includes('"aviso"')) temMarca = true;
        return { rows: [], rowsAffected: 1 };
      }
      if (/tool_json->>'aviso'/i.test(sql)) return { rows: temMarca ? [{ N: 1 }] : [] };
      return { rows: [] };
    },
  };
  assert.equal(await hist.jaAvisou(conn, 1, 88, 'video'), false);
  await hist.salvar(conn, 1, 88, 'assistant', { texto: 'me manda por texto', aviso: 'video' });
  assert.equal(await hist.jaAvisou(conn, 1, 88, 'video'), true);
});
