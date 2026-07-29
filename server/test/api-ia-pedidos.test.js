'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
// FIL-85 — a tela de conferência dos pedidos que a IA registrou.
//
// Pontos que estes testes seguram:
//  - conferir/descartar é ato de ATENDIMENTO; AUDITOR é somente-leitura;
//  - a decisão registra QUEM e QUANDO, e o segundo clique não sobrescreve o
//    primeiro (dois atendentes com a lista aberta ao mesmo tempo);
//  - o atendente comum não enxerga pedido de conversa fora do escopo dele;
//  - os RÓTULOS vêm do payload, não do template atual — template editado depois
//    não pode reescrever um pedido antigo.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');

const rotas = require('../api/iaPedidos');

const TENANT = 94001;

function servidor(perfil = { papel: 'ATENDENTE', atendenteId: 4, deptoIds: [] }, tenantId = TENANT) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { matricula: 10, tenantId, nome: 'Ana' };
    req.perfil = perfil; req.tenantId = tenantId; next();
  });
  app.use('/api/ia-pedidos', rotas);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

function req(app, metodo, caminho, corpo) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const dados = corpo === undefined ? null : JSON.stringify(corpo);
      const r = http.request({
        port: srv.address().port, path: caminho, method: metodo,
        headers: { 'content-type': 'application/json', ...(dados ? { 'content-length': Buffer.byteLength(dados) } : {}) },
      }, (res) => {
        let d = ''; res.on('data', (c) => (d += c));
        res.on('end', () => { srv.close(); let body = null; try { body = d ? JSON.parse(d) : null; } catch { /* não-JSON */ }
          resolve({ status: res.statusCode, body }); });
      });
      if (dados) r.write(dados);
      r.end();
    });
  });
}

const PAYLOAD = {
  titulo: 'Pedido de delivery',
  campos: {
    sabor: { rotulo: 'Sabor', tipo: 'opcoes', valor: 'Calabresa', posicao: 0 },
    quantidade: { rotulo: 'Quantidade', tipo: 'numero', valor: 2, posicao: 1 },
  },
};

const LINHA = {
  ID: 501, CONVERSA_ID: 88, CONTATO_ID: 7, TITULO: 'Pedido de delivery', PAYLOAD,
  STATUS: 'rascunho', OBSERVACAO: null, CRIADO_EM: '2026-07-29T10:00:00Z', CONFERIDO_EM: null,
  CONFERIDO_POR_NOME: null, NOME_INTERNO: 'Maria', TELEFONE: '5562999990000', PROTOCOLO: 'P1',
};

function banco({ iaHabilitada = 'S', lista = [LINHA], atual = { ID: 501, STATUS: 'rascunho', CONVERSA_ID: 88, CONTATO_ID: 7, TITULO: 'Pedido de delivery' }, afetadas = 1, erro = null } = {}) {
  const estado = { consultas: [], escritas: [], auditoria: [] };
  db.getConnection = async () => ({
    async execute(sql, b = {}) {
      if (/^(SET|SELECT set_config|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql)) return { rows: [] };
      if (sql.includes('SELECT ia_habilitada')) return { rows: [{ IA_HABILITADA: iaHabilitada }] };
      if (erro) throw erro;
      const ehSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
      if (ehSelect && sql.includes('FROM ia_pedido')) {
        estado.consultas.push({ sql, binds: b });
        if (sql.includes('p.payload')) return { rows: lista };
        return { rows: atual ? [atual] : [] };
      }
      if (sql.includes('INSERT INTO auditoria')) { estado.auditoria.push(b); return { rows: [] }; }
      estado.escritas.push({ sql, binds: b });
      return { rows: [], rowsAffected: afetadas };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  });
  return estado;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
test('GET lista rascunhos por padrão, com os rótulos vindos do PAYLOAD', async () => {
  const estado = banco();
  const r = await req(servidor(), 'GET', '/api/ia-pedidos');
  assert.equal(r.status, 200);
  assert.equal(r.body.itens[0].titulo, 'Pedido de delivery');
  assert.deepEqual(r.body.itens[0].campos, [
    { nome: 'sabor', rotulo: 'Sabor', tipo: 'opcoes', valor: 'Calabresa' },
    { nome: 'quantidade', rotulo: 'Quantidade', tipo: 'numero', valor: 2 },
  ]);
  assert.equal(r.body.itens[0].contatoNome, 'Maria');
  assert.equal(estado.consultas[0].binds.status, 'rascunho', 'o default é o que precisa de gente');
});

test('template editado DEPOIS não corrompe pedido antigo (o rótulo é o do payload)', async () => {
  // A empresa renomeou "Sabor" para "Item do cardápio" no template. O pedido
  // registrado antes tem que continuar dizendo "Sabor".
  banco({ lista: [{ ...LINHA, PAYLOAD: { titulo: 'Pedido', campos: { sabor: { rotulo: 'Sabor', tipo: 'texto', valor: 'Calabresa', posicao: 0 } } } }] });
  const r = await req(servidor(), 'GET', '/api/ia-pedidos');
  assert.equal(r.body.itens[0].campos[0].rotulo, 'Sabor');
});

// Achado de review (P2, PR #33): `campos` é jsonb e o Postgres canonicaliza a
// ordem das chaves (curta primeiro, depois bytes) — `Object.keys` devolve a
// ordem DO BANCO, não a que o admin configurou.
test('os campos saem na ordem do TEMPLATE, não na ordem que o jsonb devolveu', async () => {
  banco({ lista: [{ ...LINHA,
    // Como o Postgres devolveria: "data" (4 letras) antes de "servico" (7).
    PAYLOAD: { titulo: 'Agendamento', campos: {
      data: { rotulo: 'Data', tipo: 'data', valor: '2026-08-01', posicao: 1 },
      servico: { rotulo: 'Serviço', tipo: 'texto', valor: 'Corte', posicao: 0 },
    } } }] });
  const r = await req(servidor(), 'GET', '/api/ia-pedidos');
  assert.deepEqual(r.body.itens[0].campos.map((c) => c.nome), ['servico', 'data']);
  assert.ok(!('posicao' in r.body.itens[0].campos[0]), 'a posição é detalhe interno, não vai para a tela');
});

test('pedido gravado ANTES da correção (sem posição) continua legível', async () => {
  banco({ lista: [{ ...LINHA,
    PAYLOAD: { titulo: 'Pedido', campos: {
      sabor: { rotulo: 'Sabor', tipo: 'texto', valor: 'Calabresa' },
      quantidade: { rotulo: 'Quantidade', tipo: 'numero', valor: 1 },
    } } }] });
  const r = await req(servidor(), 'GET', '/api/ia-pedidos');
  assert.deepEqual(r.body.itens[0].campos.map((c) => c.nome), ['sabor', 'quantidade']);
});

test('GET aceita filtro por status e por conversa (é o atalho do badge)', async () => {
  const estado = banco();
  await req(servidor(), 'GET', '/api/ia-pedidos?status=conferido&conversaId=88');
  assert.equal(estado.consultas[0].binds.status, 'conferido');
  assert.equal(estado.consultas[0].binds.cv, 88);
  const invalido = await req(servidor(), 'GET', '/api/ia-pedidos?status=faturado');
  assert.equal(invalido.status, 400);
});

// Achado de review (P1, PR #33): o escopo daqui era MAIS LARGO que o da lista
// de conversas — admitia conversa de colega dentro do departamento e ignorava a
// restrição por canal. Como o mesmo filtro guarda o conferir/descartar, virava
// porta lateral para o dado que o inbox esconde de propósito.
test('ESCOPO: ADMIN e AUDITOR veem tudo; SUPERVISOR já é filtrado por departamento', async () => {
  const estadoAdmin = banco();
  await req(servidor({ papel: 'ADMIN', atendenteId: 1, deptoIds: [] }), 'GET', '/api/ia-pedidos');
  assert.ok(!/departamento_id/i.test(estadoAdmin.consultas[0].sql));

  const estadoAuditor = banco();
  await req(servidor({ papel: 'AUDITOR', atendenteId: null, deptoIds: [] }), 'GET', '/api/ia-pedidos');
  assert.ok(!/departamento_id/i.test(estadoAuditor.consultas[0].sql));

  const estadoSupervisor = banco();
  await req(servidor({ papel: 'SUPERVISOR', atendenteId: 1, deptoIds: [9] }), 'GET', '/api/ia-pedidos');
  const sqlSup = estadoSupervisor.consultas[0].sql;
  assert.match(sqlSup, /c\.departamento_id IN \(:escDep0\)/, 'supervisor vê o departamento dele, não a carteira toda');
  assert.ok(!/atendente_id IS NULL/.test(sqlSup), 'mas vê também o que já está com um atendente (supervisão)');
});

test('ESCOPO: atendente comum não vê pedido de conversa já atribuída a um colega', async () => {
  const estado = banco();
  await req(servidor({ papel: 'ATENDENTE', atendenteId: 4, deptoIds: [9] }), 'GET', '/api/ia-pedidos');
  const sql = estado.consultas[0].sql;
  // Exatamente a "visibilidade exclusiva" de api/conversas.js: sem dono OU minha.
  assert.match(sql, /\(c\.departamento_id IS NULL AND c\.atendente_id IS NULL\)/);
  assert.match(sql, /c\.atendente_id = :escopoAtd/);
  assert.match(sql, /\(c\.departamento_id IN \(:escDep0\) AND c\.atendente_id IS NULL\)/);
  assert.equal(estado.consultas[0].binds.escDep0, 9);
});

test('ESCOPO: atendente restrito por CANAL não vê pedido de conversa de outro número', async () => {
  const estado = banco();
  await req(servidor({ papel: 'ATENDENTE', atendenteId: 4, deptoIds: [9], numeroIds: [2] }), 'GET', '/api/ia-pedidos');
  const sql = estado.consultas[0].sql;
  assert.match(sql, /c\.numero_id IN \(:escNum0\)/, 'sem isto o pedido devolve o que a fila do canal esconde');
  assert.match(sql, /c\.numero_id IS NULL/);
  assert.equal(estado.consultas[0].binds.escNum0, 2);
});

test('ESCOPO: conferir/descartar usa o MESMO filtro da leitura (não só a lista)', async () => {
  const estado = banco();
  await req(servidor({ papel: 'ATENDENTE', atendenteId: 4, deptoIds: [9], numeroIds: [2] }),
    'POST', '/api/ia-pedidos/501/conferir');
  const busca = estado.consultas[0].sql;
  assert.match(busca, /c\.atendente_id = :escopoAtd/);
  assert.match(busca, /c\.numero_id IN \(:escNum0\)/);
});

test('add-on desligado bloqueia a rota inteira', async () => {
  banco({ iaHabilitada: 'N' });
  assert.equal((await req(servidor(), 'GET', '/api/ia-pedidos')).status, 400);
  assert.equal((await req(servidor(), 'POST', '/api/ia-pedidos/1/conferir')).status, 400);
});

test('migração 022 pendente: lista vazia em vez de 500', async () => {
  const err = new Error('relation "ia_pedido" does not exist'); err.code = '42P01';
  banco({ erro: err });
  const r = await req(servidor(), 'GET', '/api/ia-pedidos');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { itens: [], proximo: null });
});

// Achado de review (P2, PR #33): a fila tinha teto e nenhuma continuação — num
// tenant movimentado, rascunho além do corte sumia sem ninguém resolver.
test('paginação por cursor: a página cheia devolve o `proximo` para continuar', async () => {
  const muitos = Array.from({ length: 31 }, (_, i) => ({ ...LINHA, ID: 600 - i }));
  const estado = banco({ lista: muitos });
  const r = await req(servidor(), 'GET', '/api/ia-pedidos');
  assert.equal(r.body.itens.length, 30, 'a linha extra é só o sinal de "tem mais", não entra na página');
  assert.equal(r.body.proximo, 571, 'o cursor é o id do último item devolvido');
  assert.equal(estado.consultas[0].binds.limite, 31, 'pede uma a mais para saber se há próxima sem COUNT(*)');
  assert.match(estado.consultas[0].sql, /ORDER BY p\.id DESC/,
    'ordenar por id (IDENTITY) é o que torna o cursor exato — com OFFSET, pedido novo faria um rascunho pular a página');
});

test('última página não devolve cursor (senão a tela pediria para sempre)', async () => {
  banco({ lista: [LINHA] });
  const r = await req(servidor(), 'GET', '/api/ia-pedidos');
  assert.equal(r.body.proximo, null);
});

test('a próxima página filtra por id menor que o cursor', async () => {
  const estado = banco();
  await req(servidor(), 'GET', '/api/ia-pedidos?antes=571');
  assert.match(estado.consultas[0].sql, /p\.id < :antes/);
  assert.equal(estado.consultas[0].binds.antes, 571);
});

// ---------------------------------------------------------------------------
// Conferir / descartar
// ---------------------------------------------------------------------------
test('conferir registra status, quem e quando, deixa nota na timeline e audita', async () => {
  const estado = banco();
  const r = await req(servidor(), 'POST', '/api/ia-pedidos/501/conferir');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'conferido');

  const upd = estado.escritas.find((e) => /^UPDATE ia_pedido/i.test(e.sql.trim()));
  assert.equal(upd.binds.novo, 'conferido');
  assert.equal(upd.binds.atd, 4, 'quem conferiu');
  assert.match(upd.sql, /conferido_em = now\(\)/, 'quando conferiu');
  assert.match(upd.sql, /AND status = 'rascunho'/, 'guarda de corrida no próprio UPDATE');

  const nota = estado.escritas.find((e) => /INSERT INTO mensagem/i.test(e.sql));
  assert.match(nota.binds.txt, /conferido por Ana/);
  assert.equal(estado.auditoria[0].acao, 'ia_pedido_conferido');
});

test('descartar guarda o motivo em observação', async () => {
  const estado = banco();
  const r = await req(servidor(), 'POST', '/api/ia-pedidos/501/descartar', { observacao: 'cliente desistiu' });
  assert.equal(r.status, 200);
  const upd = estado.escritas.find((e) => /^UPDATE ia_pedido/i.test(e.sql.trim()));
  assert.equal(upd.binds.novo, 'descartado');
  assert.equal(upd.binds.obs, 'cliente desistiu');
  const nota = estado.escritas.find((e) => /INSERT INTO mensagem/i.test(e.sql));
  assert.match(nota.binds.txt, /cliente desistiu/);
});

test('pedido JÁ decidido devolve 409 (o segundo clique não sobrescreve o primeiro)', async () => {
  const estado = banco({ atual: { ID: 501, STATUS: 'conferido', CONVERSA_ID: 88, CONTATO_ID: 7, TITULO: 'P' } });
  const r = await req(servidor(), 'POST', '/api/ia-pedidos/501/conferir');
  assert.equal(r.status, 409);
  assert.ok(!estado.escritas.some((e) => /^UPDATE ia_pedido/i.test(e.sql.trim())));
});

test('corrida no UPDATE (0 linhas) também vira 409, não sucesso silencioso', async () => {
  banco({ afetadas: 0 });
  const r = await req(servidor(), 'POST', '/api/ia-pedidos/501/conferir');
  assert.equal(r.status, 409);
});

test('pedido inexistente (ou fora do escopo) é 404', async () => {
  banco({ atual: null });
  const r = await req(servidor(), 'POST', '/api/ia-pedidos/999/conferir');
  assert.equal(r.status, 404);
});

test('AUDITOR não confere nem descarta (somente-leitura em todo o produto)', async () => {
  banco();
  const auditor = servidor({ papel: 'AUDITOR', atendenteId: null, deptoIds: [] });
  assert.equal((await req(auditor, 'POST', '/api/ia-pedidos/501/conferir')).status, 403);
  assert.equal((await req(auditor, 'POST', '/api/ia-pedidos/501/descartar')).status, 403);
  assert.equal((await req(auditor, 'GET', '/api/ia-pedidos')).status, 200, 'mas continua vendo');
});

test('SEGURANÇA: toda query leva o tenant_id do chamador', async () => {
  const estado = banco();
  const app = servidor({ papel: 'ADMIN', atendenteId: 1, deptoIds: [] }, 555);
  await req(app, 'GET', '/api/ia-pedidos');
  await req(app, 'POST', '/api/ia-pedidos/501/conferir');
  assert.ok(estado.consultas.every((c) => c.binds.tenantId === 555));
  assert.ok(estado.escritas.every((e) => e.binds.tenantId === 555));
});
