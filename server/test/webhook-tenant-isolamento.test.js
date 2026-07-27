// Testes de ISOLAMENTO DE TENANT no webhook (FIL-60) — critérios de aceite:
//   1. mensagem que chega pro phone_number_id do tenant A não aparece em
//      nenhuma listagem do tenant B.
//   2. phone_number_id desconhecido não cria conversa órfã nem atribui a um
//      tenant arbitrário.
//
// Mesma estratégia de test/db-tenant.test.js: um Postgres de mentira fiel na
// semântica que importa (RLS por tenant_id, dono do banco com bypass, papel
// de aplicação sem bypass), embrulhado como conn.execute() DIRETO (binds
// nomeados) — não precisamos re-simular o protocolo do `pg`, só o contrato
// que db/pool.js expõe pro resto do app. Roda sempre, sem rede/banco real.
'use strict';

process.env.META_APP_SECRET = 'test_app_secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify123';
process.env.WA_TOKEN = 'token_abc';
process.env.WA_PHONE_NUMBER_ID = '1112223334';
process.env.WA_BUSINESS_ACCOUNT_ID = '9998887776';

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const presence = require('../realtime/presence');
const { processPayload } = require('../webhook/processEvent');
const { invalidar: invalidarConfigCache } = require('../utils/configCache');

function linhaMaiuscula(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k.toUpperCase()] = row[k];
  return out;
}

function erroRls() {
  const e = new Error('new row violates row-level security policy');
  e.code = '42501';
  return e;
}

/** Banco de mentira compartilhado entre as "conexões" de um teste. */
function criarBancoFalso() {
  let seq = 1;
  return {
    dados: { numero: [], contato: [], conversa: [], mensagem: [] },
    proximoId: () => seq++,
  };
}

/**
 * Uma "conexão" nasce como o dono do banco (bypass RLS — é o que db/pool.js
 * faz até comTenant() rodar SET LOCAL ROLE). set_config() seta o tenant da
 * TRANSAÇÃO corrente — não existe fora de uma comTenant() no app real, então
 * não precisamos emular BEGIN/COMMIT aqui (comTenant() já é testado à parte
 * em db-tenant.test.js); só o que os dois pontos de bypass/isolamento exigem.
 */
function criarConexaoFalsa(banco) {
  let bypass = true;
  let tenantAtual = null;
  const visiveis = (tabela) =>
    bypass ? banco.dados[tabela] : banco.dados[tabela].filter((r) => String(r.tenant_id) === String(tenantAtual));

  return {
    async execute(sql, binds = {}) {
      const t = sql.trim();

      if (/^SET\s+LOCAL\s+ROLE/i.test(t)) { bypass = false; return { rows: [] }; }
      if (/set_config\(/i.test(t)) { tenantAtual = binds.tid; return { rows: [] }; }

      // resolverNumero() — roda numa conexão NOVA, sem comTenant, com bypass
      // (é o único lookup do módulo fora de RLS — ver webhook/processEvent.js).
      if (/FROM\s+numero/i.test(t) && /phone_number_id/i.test(t)) {
        const row = banco.dados.numero.find((n) => n.phone_number_id === binds.p);
        return { rows: row ? [linhaMaiuscula(row)] : [] };
      }

      // acharContato (utils/telefone.js — fora do escopo do FIL-60, ainda usa
      // o nome de tabela do fork). Respeita RLS como qualquer outra tabela.
      if (/FROM\s+MC_ZAP_CONTATO/i.test(t)) {
        const alvos = Object.values(binds);
        const achado = visiveis('contato').find((c) => alvos.includes(c.telefone));
        return { rows: achado ? [linhaMaiuscula({ id: achado.id, nome_perfil: achado.nome_perfil })] : [] };
      }
      if (/^INSERT\s+INTO\s+contato/i.test(t)) {
        if (!bypass && tenantAtual == null) throw erroRls();
        const row = { id: banco.proximoId(), tenant_id: bypass ? null : tenantAtual, telefone: binds.tel, nome_perfil: binds.nome || null };
        banco.dados.contato.push(row);
        return { outBinds: { id: [row.id] } };
      }

      // openOrRenewConversa: SELECT específico (contato_id + numero_id, ainda aberta).
      if (/^SELECT\s+id,\s*departamento_id,\s*fila_status,\s*protocolo,\s*aviso_fora_horario\s+FROM\s+conversa/i.test(t)) {
        const rows = visiveis('conversa').filter((c) => c.contato_id === binds.cid && c.status !== 'resolvida');
        return { rows: rows.map(linhaMaiuscula) };
      }
      if (/^INSERT\s+INTO\s+conversa/i.test(t)) {
        if (!bypass && tenantAtual == null) throw erroRls();
        const row = {
          id: banco.proximoId(), tenant_id: bypass ? null : tenantAtual,
          contato_id: binds.cid, numero_id: binds.num, status: 'aberta',
          departamento_id: binds.dep, fila_status: binds.fst, protocolo: binds.prot,
        };
        banco.dados.conversa.push(row);
        return { outBinds: { id: [row.id] } };
      }
      // Verificação do teste: lista "crua" de conversas visíveis ao tenant do contexto.
      if (/^SELECT\s+id\s+FROM\s+conversa$/i.test(t)) {
        return { rows: visiveis('conversa').map(linhaMaiuscula) };
      }

      if (/^INSERT\s+INTO\s+mensagem/i.test(t)) {
        if (!bypass && tenantAtual == null) throw erroRls();
        const row = {
          id: banco.proximoId(), tenant_id: bypass ? null : tenantAtual,
          conversa_id: binds.cv, contato_id: binds.ct, numero_id: binds.num,
          wamid: binds.wamid, tipo: binds.tipo, conteudo: binds.cont,
        };
        banco.dados.mensagem.push(row);
        return { rows: [] };
      }
      // Verificação do teste: mensagens visíveis ao tenant do contexto.
      if (/^SELECT\s+conteudo\s+FROM\s+mensagem$/i.test(t)) {
        return { rows: visiveis('mensagem').map(linhaMaiuscula) };
      }

      // Config (utils/configCache.js — fora do escopo), rastro de campanha,
      // guarda de reação: nada disso participa destes cenários — resposta vazia.
      return { rows: [], outBinds: {}, rowsAffected: 1 };
    },
    commit: async () => {},
    rollback: async () => {},
    close: async () => {},
  };
}

function payloadTexto({ phoneNumberId, telefone, texto }) {
  return {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: phoneNumberId, display_phone_number: '556200000000' },
          contacts: [{ wa_id: telefone, profile: { name: 'Cliente' } }],
          messages: [{ id: `wamid.${Math.random()}`, from: telefone, timestamp: '1718000000', type: 'text', text: { body: texto } }],
        },
      }],
    }],
  };
}

test('webhook: mensagem do phone_number_id do tenant A não aparece em listagem do tenant B', async () => {
  presence._reset();
  invalidarConfigCache();
  const TENANT_A = 1;
  const TENANT_B = 2;
  const banco = criarBancoFalso();
  banco.dados.numero.push({ id: 10, tenant_id: TENANT_A, phone_number_id: 'PNID-A', modo: 'padrao', departamento_padrao_id: null });
  db.getConnection = async () => criarConexaoFalsa(banco);

  await processPayload(payloadTexto({ phoneNumberId: 'PNID-A', telefone: '5562999990000', texto: 'Oi, tudo bem?' }));

  const vistoPeloA = await db.comTenant(TENANT_A, async (conn) => (await conn.execute('SELECT id FROM conversa')).rows);
  assert.equal(vistoPeloA.length, 1, 'tenant A deveria ver a própria conversa');

  const mensagensDoA = await db.comTenant(TENANT_A, async (conn) => (await conn.execute('SELECT conteudo FROM mensagem')).rows);
  assert.equal(mensagensDoA.length, 1);
  assert.equal(mensagensDoA[0].CONTEUDO, 'Oi, tudo bem?');

  const vistoPeloB = await db.comTenant(TENANT_B, async (conn) => (await conn.execute('SELECT id FROM conversa')).rows);
  assert.deepEqual(vistoPeloB, [], 'VAZAMENTO: tenant B enxergou a conversa do tenant A');

  const mensagensDoB = await db.comTenant(TENANT_B, async (conn) => (await conn.execute('SELECT conteudo FROM mensagem')).rows);
  assert.deepEqual(mensagensDoB, [], 'VAZAMENTO: tenant B enxergou a mensagem do tenant A');

  // Prova direta no banco de mentira: as linhas criadas realmente têm o
  // tenant_id do dono do phone_number_id, não NULL nem outro tenant.
  assert.ok(banco.dados.conversa.every((c) => String(c.tenant_id) === String(TENANT_A)));
  assert.ok(banco.dados.mensagem.every((m) => String(m.tenant_id) === String(TENANT_A)));
});

test('webhook: phone_number_id desconhecido não cria conversa órfã nem atribui tenant arbitrário', async () => {
  presence._reset();
  invalidarConfigCache();
  const banco = criarBancoFalso(); // nenhum `numero` cadastrado — número não provisionado
  db.getConnection = async () => criarConexaoFalsa(banco);

  await processPayload(payloadTexto({ phoneNumberId: 'PNID-FANTASMA', telefone: '5562999990000', texto: 'oi' }));

  assert.equal(banco.dados.contato.length, 0, 'não deveria ter criado contato');
  assert.equal(banco.dados.conversa.length, 0, 'não deveria ter criado conversa órfã');
  assert.equal(banco.dados.mensagem.length, 0, 'não deveria ter gravado mensagem sem tenant');
});
