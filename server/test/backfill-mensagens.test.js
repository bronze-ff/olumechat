// FIL-102 — o backfill de mensagens não pode atravessar empresas.
//
// O script rodava com `db.getConnection()` cru: sem `SET LOCAL ROLE` a RLS não
// vale nada (o usuário do DATABASE_URL é o dono do banco, com BYPASSRLS), então
// a prévia imprimia conteúdo de mensagem de todos os tenants e o `--commit`
// reescrevia o histórico de todos. Estes testes provam as duas metades da
// correção: alvo obrigatório na linha de comando e escopo de tenant no banco.
//
// Mesma estratégia de test/webhook-tenant-isolamento.test.js: um Postgres de
// mentira fiel na semântica que importa (RLS por tenant_id, dono do banco com
// bypass, papel de aplicação sem bypass) por trás do comTenant() DE VERDADE.
// Roda sempre, sem rede nem banco real.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const db = require('../db/pool');
const { parseArgs, main } = require('../scripts/backfill-mensagens');

const TENANT_A = 1;
const TENANT_B = 2;

function linhaMaiuscula(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k.toUpperCase()] = row[k];
  return out;
}

/** Duas empresas, cada uma com uma mensagem `in` gravada como JSON cru. */
function criarBancoFalso() {
  return {
    tenant: [
      { id: TENANT_A, nome: 'Empresa A' },
      { id: TENANT_B, nome: 'Empresa B' },
    ],
    mensagem: [
      { id: 10, tenant_id: TENANT_A, direcao: 'in', tipo: 'button', conteudo: '{"text":"Sim, quero"}' },
      { id: 20, tenant_id: TENANT_B, direcao: 'in', tipo: 'button', conteudo: '{"text":"SEGREDO DO TENANT B"}' },
      // Fora dos filtros do SELECT: já reescrita (não começa com { ou [) e saída.
      { id: 30, tenant_id: TENANT_A, direcao: 'in', tipo: 'button', conteudo: 'Sim, quero' },
      { id: 40, tenant_id: TENANT_A, direcao: 'out', tipo: 'button', conteudo: '{"text":"saida"}' },
    ],
  };
}

/**
 * Conexão de mentira: nasce como o dono do banco (bypass RLS — é o estado real
 * até comTenant() rodar `SET LOCAL ROLE`). `set_config` define o tenant da
 * transação. As policies emuladas são as da migração 001: `isolamento_tenant`
 * em `mensagem` e `tenant_proprio` em `tenant`.
 */
function criarConexaoFalsa(banco) {
  let bypass = true;
  let tenantAtual = null;
  const visiveis = (tabela, campoTenant) =>
    bypass ? banco[tabela] : banco[tabela].filter((r) => String(r[campoTenant]) === String(tenantAtual));

  return {
    async execute(sql, binds = {}) {
      const t = sql.trim();

      if (/^SET\s+LOCAL\s+ROLE/i.test(t)) { bypass = false; return { rows: [] }; }
      if (/set_config\(/i.test(t)) { tenantAtual = binds.tid; return { rows: [] }; }

      if (/FROM\s+tenant/i.test(t)) {
        const rows = visiveis('tenant', 'id').filter((r) => String(r.id) === String(binds.tid));
        return { rows: rows.map(linhaMaiuscula) };
      }

      if (/^SELECT[\s\S]*FROM\s+mensagem/i.test(t)) {
        const tipos = Object.keys(binds).filter((k) => /^t\d+$/.test(k)).map((k) => binds[k]);
        let rows = visiveis('mensagem', 'tenant_id');
        // Filtro explícito do SQL (cinto E suspensório do script) — só aplicado
        // se ele realmente estiver lá.
        if (/TENANT_ID\s*=\s*:tid/i.test(t)) rows = rows.filter((m) => String(m.tenant_id) === String(binds.tid));
        rows = rows.filter((m) => m.direcao === 'in' && tipos.includes(m.tipo)
          && (m.conteudo.startsWith('{') || m.conteudo.startsWith('[')));
        return { rows: rows.map((m) => linhaMaiuscula({ id: m.id, tipo: m.tipo, conteudo: m.conteudo })) };
      }

      if (/^UPDATE\s+mensagem/i.test(t)) {
        let alvos = visiveis('mensagem', 'tenant_id').filter((m) => m.id === binds.id);
        if (/TENANT_ID\s*=\s*:tid/i.test(t)) alvos = alvos.filter((m) => String(m.tenant_id) === String(binds.tid));
        alvos.forEach((m) => { m.conteudo = binds.c; });
        return { rows: [], rowsAffected: alvos.length };
      }

      throw new Error(`SQL inesperado no teste: ${t}`);
    },
    commit: async () => {},
    rollback: async () => {},
    close: async () => {},
  };
}

/** `deps` do main(): pool de mentira + comTenant() de verdade + log capturado. */
function montarDeps(banco) {
  db.getConnection = async () => criarConexaoFalsa(banco);
  const saida = [];
  return {
    saida,
    deps: {
      db: { initPool: async () => {}, closePool: async () => {}, comTenant: db.comTenant },
      log: (s) => saida.push(String(s)),
      erro: (s) => saida.push(String(s)),
    },
  };
}

// ── Alvo obrigatório na linha de comando ────────────────────────────────────

test('parseArgs: sem --tenant recusa', () => {
  const r = parseArgs([]);
  assert.equal(r.ok, false);
  assert.match(r.erro, /--tenant/);
});

test('parseArgs: --commit sozinho continua recusando', () => {
  assert.equal(parseArgs(['--commit']).ok, false);
});

test('parseArgs: --tenant não-inteiro-positivo recusa', () => {
  for (const v of ['0', '-1', 'abc', '1.5', '', 'null']) {
    const r = parseArgs([`--tenant=${v}`]);
    assert.equal(r.ok, false, `--tenant=${v} deveria ser recusado`);
  }
});

test('parseArgs: alvo válido devolve id numérico e o modo', () => {
  assert.deepEqual(parseArgs(['--tenant=7']), { ok: true, tenantId: 7, commit: false });
  assert.deepEqual(parseArgs(['--tenant=7', '--commit']), { ok: true, tenantId: 7, commit: true });
});

test('main sem alvo sai com código 1 e NÃO abre conexão', async () => {
  db.getConnection = async () => { throw new Error('não deveria abrir conexão sem alvo'); };
  let abriuPool = false;
  const saida = [];
  const code = await main([], {
    db: { initPool: async () => { abriuPool = true; }, closePool: async () => {}, comTenant: db.comTenant },
    log: (s) => saida.push(String(s)),
    erro: (s) => saida.push(String(s)),
  });
  assert.equal(code, 1);
  assert.equal(abriuPool, false, 'nem o pool deveria ser aberto sem alvo declarado');
  assert.match(saida.join('\n'), /--tenant/);
});

// ── Escopo de tenant no banco ───────────────────────────────────────────────

test('prévia não imprime conteúdo de outra empresa', async () => {
  const banco = criarBancoFalso();
  const { saida, deps } = montarDeps(banco);

  const code = await main([`--tenant=${TENANT_A}`], deps);

  assert.equal(code, 0);
  const texto = saida.join('\n');
  assert.match(texto, /Empresa A/);
  assert.match(texto, /#10/);
  assert.doesNotMatch(texto, /SEGREDO DO TENANT B/, 'VAZAMENTO: prévia imprimiu mensagem de outro tenant');
  assert.doesNotMatch(texto, /#20/);
  assert.match(texto, /Seriam reescritos: 1/);
  // Dry-run não grava nada.
  assert.equal(banco.mensagem.find((m) => m.id === 10).conteudo, '{"text":"Sim, quero"}');
});

test('--commit reescreve só as mensagens da empresa alvo', async () => {
  const banco = criarBancoFalso();
  const { saida, deps } = montarDeps(banco);

  const code = await main([`--tenant=${TENANT_A}`, '--commit'], deps);

  assert.equal(code, 0);
  assert.match(saida.join('\n'), /Reescritos: 1/);
  assert.equal(banco.mensagem.find((m) => m.id === 10).conteudo, 'Sim, quero');
  assert.equal(
    banco.mensagem.find((m) => m.id === 20).conteudo,
    '{"text":"SEGREDO DO TENANT B"}',
    'VAZAMENTO: o backfill reescreveu mensagem de outro tenant'
  );
  // Mensagem já reescrita e mensagem de saída ficam intocadas.
  assert.equal(banco.mensagem.find((m) => m.id === 30).conteudo, 'Sim, quero');
  assert.equal(banco.mensagem.find((m) => m.id === 40).conteudo, '{"text":"saida"}');
});

test('o alvo do --tenant é o que vale: rodar como B não toca em A', async () => {
  const banco = criarBancoFalso();
  const { deps } = montarDeps(banco);

  await main([`--tenant=${TENANT_B}`, '--commit'], deps);

  assert.equal(banco.mensagem.find((m) => m.id === 20).conteudo, 'SEGREDO DO TENANT B');
  assert.equal(banco.mensagem.find((m) => m.id === 10).conteudo, '{"text":"Sim, quero"}');
});

test('sem troca de papel (DB_APP_ROLE vazio) o filtro no SQL ainda isola', async () => {
  const anterior = process.env.DB_APP_ROLE;
  process.env.DB_APP_ROLE = ''; // desliga SET LOCAL ROLE ⇒ conexão com BYPASSRLS
  try {
    const banco = criarBancoFalso();
    const { saida, deps } = montarDeps(banco);

    await main([`--tenant=${TENANT_A}`, '--commit'], deps);

    assert.doesNotMatch(saida.join('\n'), /SEGREDO DO TENANT B/);
    assert.equal(banco.mensagem.find((m) => m.id === 10).conteudo, 'Sim, quero');
    assert.equal(banco.mensagem.find((m) => m.id === 20).conteudo, '{"text":"SEGREDO DO TENANT B"}');
  } finally {
    if (anterior === undefined) delete process.env.DB_APP_ROLE;
    else process.env.DB_APP_ROLE = anterior;
  }
});

test('tenant inexistente falha em vez de terminar com "0 candidatos"', async () => {
  const banco = criarBancoFalso();
  const { deps } = montarDeps(banco);

  await assert.rejects(() => main(['--tenant=999', '--commit'], deps), /tenant 999 não existe/);
  assert.equal(banco.mensagem.find((m) => m.id === 10).conteudo, '{"text":"Sim, quero"}');
});
