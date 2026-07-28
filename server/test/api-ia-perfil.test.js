'use strict';
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';
// FIL-83 — rotas de instruções/ficha/base de conhecimento da IA.
//
// Pontos que estes testes seguram:
//  - papel errado não lê nem escreve (SEGURANCA.md §3: autorização no backend);
//  - tudo atrás do add-on (tenant.ia_habilitada), não só escondido na UI;
//  - limites de tamanho dão 400 claro em vez de estourar no provedor;
//  - POST /testar REGISTRA CONSUMO e respeita o teto — senão vira porta dos
//    fundos pra gastar token do provedor sem aparecer no consumo do cliente.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const db = require('../db/pool');
const perfilStore = require('../ia/perfilStore');
const iaConfigStore = require('../ia/iaConfigStore');
const client = require('../ia/client');
const precos = require('../consumo/precos');

const rotas = require('../api/iaPerfil');

const TENANT = 92001;

function servidor(papel = 'ADMIN', tenantId = TENANT) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { matricula: 10, tenantId }; req.perfil = { atendenteId: 1, papel }; req.tenantId = tenantId; next();
  });
  app.use('/api/ia-perfil', rotas.perfil);
  app.use('/api/ia-conhecimento', rotas.conhecimento);
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

/** Banco falso. `estado` guarda o que foi escrito para as asserções. */
function banco({ iaHabilitada = 'S', perfil = null, blocos = [], totalBlocos = null, teto = null, usados = 0, afetadas = 1 } = {}) {
  const estado = { escritas: [], auditoria: [], consumo: [] };
  db.getConnection = async () => ({
    async execute(sql, b = {}) {
      if (/^(SET|SELECT set_config|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql)) return { rows: [] };
      if (sql.includes('SELECT ia_habilitada')) return { rows: [{ IA_HABILITADA: iaHabilitada }] };
      if (sql.includes('ia_teto_tokens_mes')) return { rows: [{ IA_TETO_TOKENS_MES: teto }] };
      if (sql.includes('FROM ia_consumo_mensal')) return { rows: [{ TOKENS_USADOS: usados }] };
      const ehSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
      if (ehSelect && sql.includes('FROM ia_perfil')) return { rows: perfil ? [perfil] : [] };
      if (ehSelect && sql.includes('count(*)') && sql.includes('ia_conhecimento')) {
        return { rows: [{ N: totalBlocos === null ? blocos.length : totalBlocos }] };
      }
      if (ehSelect && sql.includes('FROM ia_conhecimento')) return { rows: blocos };
      if (sql.includes('INSERT INTO auditoria')) { estado.auditoria.push(b); return { rows: [] }; }
      if (sql.includes('INSERT INTO consumo_evento')) { estado.consumo.push(b); return { rows: [] }; }
      if (sql.includes('INSERT INTO ia_consumo_mensal')) { estado.consumo.push(b); return { rows: [] }; }
      estado.escritas.push({ sql, binds: b });
      if (sql.includes('RETURNING id')) return { rows: [{ ID: 77 }], outBinds: { id: [77] }, rowsAffected: 1 };
      return { rows: [], rowsAffected: afetadas };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  });
  return estado;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
test('GET devolve perfil, blocos (inclusive desligados) e o medidor', async () => {
  banco({ perfil: { INSTRUCOES: 'Sou a Ana', FICHA: { endereco: 'Rua A' }, ATUALIZADO_EM: null },
    blocos: [
      { ID: 1, TITULO: 'Cardápio', CONTEUDO: 'pizza', ATIVO: 'S', ORDEM: 0, ATUALIZADO_EM: null },
      { ID: 2, TITULO: 'Natal', CONTEUDO: 'rabanada', ATIVO: 'N', ORDEM: 1, ATUALIZADO_EM: null },
    ] });
  const r = await req(servidor('ADMIN'), 'GET', '/api/ia-perfil');
  assert.equal(r.status, 200);
  assert.equal(r.body.instrucoes, 'Sou a Ana');
  assert.equal(r.body.blocos.length, 2, 'a tela precisa ver o bloco desligado pra poder religar');
  assert.equal(r.body.blocos[1].ativo, false);
  // O medidor mede o que vai no prompt a cada mensagem: só o bloco ativo.
  assert.ok(r.body.medidor.caracteres > 0 && !String(r.body.medidor.caracteres).includes('NaN'));
  assert.equal(r.body.medidor.faixa, 'verde');
  assert.equal(r.body.limites.instrucoes, perfilStore.LIMITES.instrucoes);
});

test('GET: SUPERVISOR e AUDITOR leem; ATENDENTE não', async () => {
  banco();
  assert.equal((await req(servidor('SUPERVISOR'), 'GET', '/api/ia-perfil')).status, 200);
  // AUDITOR é o papel da sessão de suporte quando o cliente reclama "a IA
  // respondeu errado" — precisa VER as instruções que causaram aquilo.
  assert.equal((await req(servidor('AUDITOR'), 'GET', '/api/ia-perfil')).status, 200);
  assert.equal((await req(servidor('ATENDENTE'), 'GET', '/api/ia-perfil')).status, 403);
});

test('add-on de IA desligado no plano: 400 mesmo para ADMIN', async () => {
  banco({ iaHabilitada: 'N' });
  assert.equal((await req(servidor('ADMIN'), 'GET', '/api/ia-perfil')).status, 400);
  assert.equal((await req(servidor('ADMIN'), 'PUT', '/api/ia-perfil', { instrucoes: 'x' })).status, 400);
  assert.equal((await req(servidor('ADMIN'), 'POST', '/api/ia-conhecimento', { titulo: 't', conteudo: 'c' })).status, 400);
});

// ---------------------------------------------------------------------------
// Escrita do perfil
// ---------------------------------------------------------------------------
test('PUT salva instruções + ficha, audita e invalida o cache do prompt', async () => {
  const estado = banco();
  // Deixa o cache quente com um valor velho: salvar tem que derrubá-lo, senão o
  // bot segue respondendo com o texto antigo por até 60s.
  perfilStore.invalidar(TENANT);
  const connFake = { async execute(sql) {
    if (/^(SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql)) return { rows: [] };
    if (sql.includes('FROM ia_perfil')) return { rows: [{ INSTRUCOES: 'ANTIGO', FICHA: {} }] };
    return { rows: [] };
  } };
  assert.equal((await perfilStore.carregar(connFake, TENANT)).instrucoes, 'ANTIGO');

  const r = await req(servidor('ADMIN'), 'PUT', '/api/ia-perfil', {
    instrucoes: '  Sou a Ana da Pizzaria  ', ficha: { endereco: 'Rua A', invadido: 'x' },
  });
  assert.equal(r.status, 200);
  const ins = estado.escritas.find((e) => e.sql.includes('INSERT INTO ia_perfil'));
  assert.ok(ins, 'deveria ter gravado o perfil');
  assert.equal(ins.binds.ins, 'Sou a Ana da Pizzaria');
  assert.deepEqual(JSON.parse(ins.binds.ficha), { endereco: 'Rua A' }, 'chave desconhecida não pode ir pro jsonb');
  assert.equal(ins.binds.tenantId, TENANT);
  assert.equal(estado.auditoria.length, 1, 'toda escrita audita');

  connFake.execute = async (sql) => (sql.includes('FROM ia_perfil')
    ? { rows: [{ INSTRUCOES: 'NOVO', FICHA: {} }] } : { rows: [] });
  assert.equal((await perfilStore.carregar(connFake, TENANT)).instrucoes, 'NOVO', 'cache não foi invalidado ao salvar');
});

test('PUT: só ADMIN edita (SUPERVISOR e AUDITOR levam 403)', async () => {
  banco();
  assert.equal((await req(servidor('SUPERVISOR'), 'PUT', '/api/ia-perfil', { instrucoes: 'x' })).status, 403);
  assert.equal((await req(servidor('AUDITOR'), 'PUT', '/api/ia-perfil', { instrucoes: 'x' })).status, 403);
});

test('PUT: instruções acima do limite → 400 (erro claro, não estouro no provedor)', async () => {
  banco();
  const r = await req(servidor('ADMIN'), 'PUT', '/api/ia-perfil',
    { instrucoes: 'x'.repeat(perfilStore.LIMITES.instrucoes + 1) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /8000|excede/i);
});

test('PUT: campo de ficha gigante → 400', async () => {
  banco();
  const r = await req(servidor('ADMIN'), 'PUT', '/api/ia-perfil',
    { ficha: { observacoes: 'x'.repeat(perfilStore.LIMITES.fichaCampo + 1) } });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Blocos de conhecimento
// ---------------------------------------------------------------------------
test('POST cria bloco, audita e devolve o id', async () => {
  const estado = banco({ totalBlocos: 3 });
  const r = await req(servidor('ADMIN'), 'POST', '/api/ia-conhecimento', { titulo: ' Cardápio ', conteudo: ' pizza ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 77);
  const ins = estado.escritas.find((e) => e.sql.includes('INSERT INTO ia_conhecimento'));
  assert.equal(ins.binds.t, 'Cardápio');
  assert.equal(ins.binds.c, 'pizza');
  assert.equal(ins.binds.a, 'S');
  assert.equal(estado.auditoria.length, 1);
});

test('POST: limites de título, conteúdo e quantidade de blocos → 400', async () => {
  banco({ totalBlocos: 3 });
  assert.equal((await req(servidor('ADMIN'), 'POST', '/api/ia-conhecimento', { titulo: '', conteudo: 'c' })).status, 400);
  assert.equal((await req(servidor('ADMIN'), 'POST', '/api/ia-conhecimento',
    { titulo: 'x'.repeat(perfilStore.LIMITES.blocoTitulo + 1), conteudo: 'c' })).status, 400);
  assert.equal((await req(servidor('ADMIN'), 'POST', '/api/ia-conhecimento',
    { titulo: 't', conteudo: 'x'.repeat(perfilStore.LIMITES.blocoConteudo + 1) })).status, 400);

  banco({ totalBlocos: perfilStore.LIMITES.blocos });
  const cheio = await req(servidor('ADMIN'), 'POST', '/api/ia-conhecimento', { titulo: 't', conteudo: 'c' });
  assert.equal(cheio.status, 400);
  assert.match(cheio.body.error, /50/);
});

test('POST/PUT/DELETE de bloco: papel diferente de ADMIN leva 403', async () => {
  banco();
  for (const papel of ['SUPERVISOR', 'AUDITOR', 'ATENDENTE']) {
    assert.equal((await req(servidor(papel), 'POST', '/api/ia-conhecimento', { titulo: 't', conteudo: 'c' })).status, 403, papel);
    assert.equal((await req(servidor(papel), 'PUT', '/api/ia-conhecimento/1', { ativo: false })).status, 403, papel);
    assert.equal((await req(servidor(papel), 'DELETE', '/api/ia-conhecimento/1')).status, 403, papel);
  }
});

test('PUT de bloco: desliga sem apagar (cardápio sazonal) e leva o tenant_id', async () => {
  const estado = banco();
  const r = await req(servidor('ADMIN'), 'PUT', '/api/ia-conhecimento/5', { ativo: false, ordem: 3 });
  assert.equal(r.status, 200);
  const upd = estado.escritas.find((e) => e.sql.includes('UPDATE ia_conhecimento'));
  assert.equal(upd.binds.ativo, 'N');
  assert.equal(upd.binds.ordem, 3);
  assert.equal(upd.binds.tenantId, TENANT);
  assert.equal(upd.binds.id, 5);
});

test('PUT/DELETE de bloco inexistente → 404 (e não audita)', async () => {
  const estado = banco({ afetadas: 0 });
  assert.equal((await req(servidor('ADMIN'), 'PUT', '/api/ia-conhecimento/999', { ativo: false })).status, 404);
  assert.equal((await req(servidor('ADMIN'), 'DELETE', '/api/ia-conhecimento/999')).status, 404);
  assert.equal(estado.auditoria.length, 0);
});

test('DELETE remove de verdade e audita', async () => {
  const estado = banco();
  const r = await req(servidor('ADMIN'), 'DELETE', '/api/ia-conhecimento/5');
  assert.equal(r.status, 200);
  assert.ok(estado.escritas.some((e) => e.sql.includes('DELETE FROM ia_conhecimento') && e.binds.tenantId === TENANT));
  assert.equal(estado.auditoria.length, 1);
});

// ---------------------------------------------------------------------------
// POST /testar
// ---------------------------------------------------------------------------
test('testar: responde e REGISTRA o consumo de tokens', async () => {
  const estado = banco({ perfil: { INSTRUCOES: 'Sou a Ana', FICHA: {} } });
  perfilStore.invalidar(TENANT);
  iaConfigStore.carregar = async () => ({ provider: 'anthropic', modelo: 'm', apiKey: 'k' });
  precos.carregarPreco = async () => ({ precoEntradaCentavos1k: 1, precoSaidaCentavos1k: 2 });
  let sistemaVisto = null;
  client.chamar = async ({ sistema, semFerramentas }) => {
    sistemaVisto = sistema;
    assert.equal(semFerramentas, true, 'o teste não pode ganhar as ferramentas do bot');
    return { texto: 'Oi! Sou a Ana.', toolCalls: [], uso: { tokensEntrada: 100, tokensSaida: 20 } };
  };

  const r = await req(servidor('ADMIN'), 'POST', '/api/ia-perfil/testar', { pergunta: 'quem é você?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.resposta, 'Oi! Sou a Ana.');
  assert.ok(sistemaVisto.includes('Sou a Ana'), 'o teste tem que usar a configuração SALVA');
  assert.ok(!/multicanal/i.test(sistemaVisto));
  assert.ok(estado.consumo.length >= 1, 'sem registrar consumo, /testar vira porta dos fundos pra gastar token');
  assert.ok(estado.consumo.some((c) => c.tipo === 'ia_tokens' && c.qtd === 120));
});

test('testar: teto mensal estourado → 400 e NÃO chama o provedor', async () => {
  banco({ teto: 1000, usados: 1000 });
  let chamou = false;
  client.chamar = async () => { chamou = true; return { texto: 'x' }; };
  const r = await req(servidor('ADMIN'), 'POST', '/api/ia-perfil/testar', { pergunta: 'oi' });
  assert.equal(r.status, 400);
  assert.equal(chamou, false, 'não pode gastar 1 token sequer acima do teto');
  assert.ok(!/token|custo|R\$/i.test(r.body.error) || /Limite mensal/.test(r.body.error));
});

test('testar: sem provedor configurado → 400 amigável', async () => {
  banco();
  perfilStore.invalidar(TENANT);
  iaConfigStore.carregar = async () => null;
  const r = await req(servidor('ADMIN'), 'POST', '/api/ia-perfil/testar', { pergunta: 'oi' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /provedor/i);
});

test('testar: pergunta vazia → 400; papel não-ADMIN → 403', async () => {
  banco();
  assert.equal((await req(servidor('ADMIN'), 'POST', '/api/ia-perfil/testar', { pergunta: '   ' })).status, 400);
  assert.equal((await req(servidor('SUPERVISOR'), 'POST', '/api/ia-perfil/testar', { pergunta: 'oi' })).status, 403);
});
