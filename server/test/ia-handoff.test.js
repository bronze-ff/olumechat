'use strict';
// FIL-84 — cascata de destino e transições de fila do handoff.
//
// A cascata (departamento do argumento > departamento padrão do número > inbox
// geral) existia inline em api/numeros.js e passa a ser UMA função usada em
// três lugares: a cascata do modo, a ferramenta transferir_para_humano e o
// botão Assumir. Duplicar essa regra é exatamente como o bug do "canal restrito
// para sempre" nasceu na primeira vez.
const test = require('node:test');
const assert = require('node:assert');
const handoff = require('../ia/handoff');

const TENANT = 7;

/** Conexão falsa: casa por regex e devolve linhas; guarda tudo que executou. */
function fakeConn(rotas = []) {
  return {
    executadas: [],
    async execute(sql, binds = {}) {
      this.executadas.push({ sql, binds });
      for (const [re, resposta] of rotas) {
        if (re.test(sql)) return typeof resposta === 'function' ? resposta(binds) : resposta;
      }
      return { rows: [], rowsAffected: 1 };
    },
  };
}

test('cascata: departamento do argumento vence, quando válido e ativo', async () => {
  const conn = fakeConn([[/FROM departamento/i, { rows: [{ ID: 5, NOME: 'Financeiro' }] }]]);
  const d = await handoff.resolverDestino(conn, TENANT, 2, { departamentoId: 5 });
  assert.deepEqual(d, { departamentoId: 5, filaStatus: 'aguardando', fluxoId: null });
});

test('cascata: departamento do argumento inválido cai para o padrão do número', async () => {
  const conn = fakeConn([
    [/FROM departamento/i, { rows: [] }], // inválido/inativo
    [/FROM numero/i, { rows: [{ DEP: 9, FLUXO_ID: null }] }],
  ]);
  const d = await handoff.resolverDestino(conn, TENANT, 2, { departamentoId: 999 });
  assert.deepEqual(d, { departamentoId: 9, filaStatus: 'aguardando', fluxoId: null });
});

test('cascata: sem departamento nenhum vai para o inbox geral (em_atendimento)', async () => {
  const conn = fakeConn([[/FROM numero/i, { rows: [{ DEP: null, FLUXO_ID: null }] }]]);
  const d = await handoff.resolverDestino(conn, TENANT, 2, {});
  assert.deepEqual(d, { departamentoId: null, filaStatus: 'em_atendimento', fluxoId: null });
});

test('cascata: fluxo ativo só entra com permitirFluxo (cascata do MODO, não do handoff)', async () => {
  const rotas = [[/FROM numero/i, { rows: [{ DEP: 9, FLUXO_ID: 4 }] }]];
  const comFluxo = await handoff.resolverDestino(fakeConn(rotas), TENANT, 2, { permitirFluxo: true });
  assert.deepEqual(comFluxo, { departamentoId: null, filaStatus: 'bot', fluxoId: 4 });

  // Handoff IA→humano nunca joga o cliente de volta no bot de fluxo: ele pediu gente.
  const semFluxo = await handoff.resolverDestino(fakeConn(rotas), TENANT, 2, {});
  assert.deepEqual(semFluxo, { departamentoId: 9, filaStatus: 'aguardando', fluxoId: null });
});

test('acharDepartamentoPorNome casa sem diferenciar maiúscula e ignora inativo', async () => {
  const conn = fakeConn([[/FROM departamento/i, (b) => ({ rows: b.nome === 'financeiro' ? [{ ID: 5 }] : [] })]]);
  assert.equal(await handoff.acharDepartamentoPorNome(conn, TENANT, '  Financeiro '), 5);
  const vazio = fakeConn([[/FROM departamento/i, { rows: [] }]]);
  assert.equal(await handoff.acharDepartamentoPorNome(vazio, TENANT, 'Inexistente'), null);
});

test('transferirParaHumano muda a fila, deixa nota de sistema e devolve eventos', async () => {
  const conn = fakeConn([
    [/FROM departamento/i, { rows: [{ ID: 5, NOME: 'Financeiro' }] }],
    [/SELECT fila_status, protocolo FROM conversa/i, { rows: [{ FILA_STATUS: 'ia', PROTOCOLO: 'P1' }] }],
    [/^UPDATE conversa/i, { rowsAffected: 1 }],
  ]);
  const r = await handoff.transferirParaHumano(conn, TENANT, { conversaId: 88, contatoId: 3, numeroId: 2 },
    { departamentoId: 5, motivo: 'cliente pediu boleto' });

  assert.equal(r.ok, true);
  assert.equal(r.departamentoId, 5);
  assert.equal(r.filaStatus, 'aguardando');
  const upd = conn.executadas.find((e) => /^UPDATE conversa/i.test(e.sql));
  assert.match(upd.sql, /fila_status = :st/i);
  assert.match(upd.sql, /AND fila_status = 'ia'/i, 'o UPDATE precisa da guarda de corrida');
  const nota = conn.executadas.find((e) => /INSERT INTO mensagem/i.test(e.sql));
  assert.match(nota.sql, /'nota'/);
  assert.equal(nota.binds.origem, 'sistema', 'transferência da IA é evento de SISTEMA na timeline');
  assert.match(nota.binds.txt, /Financeiro/);
  assert.match(nota.binds.txt, /cliente pediu boleto/);
  assert.ok(r.eventos.some((e) => e.tipo === 'fila' && e.departamentoId === 5));
});

test('transferirParaHumano NÃO transfere se o atendente já assumiu (corrida)', async () => {
  const conn = fakeConn([
    [/SELECT fila_status, protocolo FROM conversa/i, { rows: [{ FILA_STATUS: 'em_atendimento', PROTOCOLO: 'P1' }] }],
  ]);
  const r = await handoff.transferirParaHumano(conn, TENANT, { conversaId: 88, contatoId: 3, numeroId: 2 }, {});
  assert.equal(r.ok, false);
  assert.ok(!conn.executadas.some((e) => /^UPDATE conversa/i.test(e.sql)), 'não pode escrever nada');
});

test('devolverParaIa limpa o estado de fila por completo', async () => {
  const conn = fakeConn([[/^UPDATE conversa/i, { rowsAffected: 1 }]]);
  assert.equal(await handoff.devolverParaIa(conn, TENANT, 88), true);
  const upd = conn.executadas.find((e) => /^UPDATE conversa/i.test(e.sql));
  assert.match(upd.sql, /fila_status = 'ia'/i);
  assert.match(upd.sql, /departamento_id = NULL/i);
  assert.match(upd.sql, /atendente_id = NULL/i);
  assert.match(upd.sql, /fila_entrou_em = NULL/i);
});

test('devolverParaIa recusa conversa que não está com humano', async () => {
  const conn = fakeConn([[/^UPDATE conversa/i, { rowsAffected: 0 }]]);
  assert.equal(await handoff.devolverParaIa(conn, TENANT, 88), false);
});

test('SEGURANÇA: toda query leva o tenant_id do chamador', async () => {
  const conn = fakeConn([
    [/FROM departamento/i, { rows: [{ ID: 5, NOME: 'Financeiro' }] }],
    [/SELECT fila_status, protocolo FROM conversa/i, { rows: [{ FILA_STATUS: 'ia', PROTOCOLO: 'P1' }] }],
  ]);
  await handoff.transferirParaHumano(conn, TENANT, { conversaId: 88, contatoId: 3, numeroId: 2 }, { departamentoId: 5 });
  assert.ok(conn.executadas.length > 0);
  assert.ok(conn.executadas.every((e) => e.binds.tenantId === TENANT),
    'alguma query do handoff não levou o tenant_id do chamador');
});
