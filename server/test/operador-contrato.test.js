'use strict';
// operador/contrato.js — contrato comercial por cliente (FIL-76). Mesmo
// padrão de teste de operador-consumo.test.js / operador-credencial-ia.test.js:
// comOperador roda tudo via db.getConnection (duble), sem RLS de verdade.
process.env.META_APP_SECRET='x'; process.env.WEBHOOK_VERIFY_TOKEN='x'; process.env.WA_TOKEN='x';
process.env.WA_PHONE_NUMBER_ID='x'; process.env.WA_BUSINESS_ACCOUNT_ID='x'; process.env.JWT_SECRET='seg-teste-32-chars-abcdefghijk';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../db/pool');
const contrato = require('../operador/contrato');

const OPERADOR = { id: 1, email: 'op@falatta.com' };

const DADOS_VALIDOS = {
  planoNome: 'Plano Pro', valorRecorrenteCentavos: 150000, ciclo: 'mensal',
  diaVencimento: 10, inicioCobranca: '2026-08-01',
};

function conexao({ tenantExiste = true, ativo = null, contratoRow = null, itens = [], itemRow = null } = {}) {
  const cap = [];
  return {
    cap,
    async execute(sql, binds = {}) {
      cap.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), binds });
      const s = cap[cap.length - 1].sql;
      if (/^SELECT id FROM tenant WHERE id = :id/i.test(s)) {
        return { rows: tenantExiste ? [{ ID: binds.id }] : [] };
      }
      if (/^SELECT id, plano_nome, valor_recorrente_centavos, ciclo, inicio_cobranca, fim_vigencia FROM contrato WHERE tenant_id = :tid AND fim_vigencia IS NULL/i.test(s)) {
        return { rows: ativo ? [ativo] : [] };
      }
      if (/^SELECT GREATEST\(CURRENT_DATE, :inicioAnterior\)::text AS limite/i.test(s)) {
        const hoje = new Date().toISOString().slice(0, 10);
        const inicioAnterior = String(binds.inicioAnterior).slice(0, 10);
        return { rows: [{ LIMITE: inicioAnterior > hoje ? inicioAnterior : hoje }] };
      }
      if (/^UPDATE contrato SET fim_vigencia = :dataLimite WHERE id = :id/i.test(s)) {
        return { rowsAffected: 1, rows: [] };
      }
      if (/^INSERT INTO contrato\s*\(/i.test(s)) {
        return {
          rows: [{
            ID: 501, TENANT_ID: binds.tenantId, PLANO_NOME: binds.planoNome,
            VALOR_RECORRENTE_CENTAVOS: binds.valorRecorrenteCentavos, CICLO: binds.ciclo,
            DIA_VENCIMENTO: binds.diaVencimento, INICIO_COBRANCA: binds.inicioCobranca,
            FIM_VIGENCIA: null, REAJUSTE_INDICE: binds.reajusteIndice, REAJUSTE_MES: binds.reajusteMes,
            OBSERVACOES: binds.observacoes, CRIADO_POR: binds.criadoPor, CRIADO_EM: new Date(),
          }],
        };
      }
      if (/^SELECT \* FROM contrato WHERE tenant_id = :tid ORDER BY criado_em/i.test(s)) {
        return { rows: contratoRow ? [contratoRow] : [] };
      }
      if (/^SELECT \* FROM contrato WHERE id = :id AND tenant_id = :tid/i.test(s)) {
        return { rows: contratoRow ? [contratoRow] : [] };
      }
      if (/^SELECT \* FROM contrato_item WHERE contrato_id = :cid ORDER BY criado_em/i.test(s)) {
        return { rows: itens };
      }
      if (/^INSERT INTO contrato_item/i.test(s)) {
        return {
          rows: [{
            ID: 9001, CONTRATO_ID: binds.cid, TIPO: binds.tipo, DESCRICAO: binds.desc,
            VALOR_UNITARIO_CENTAVOS: binds.valor, QUANTIDADE: binds.qtd, RECORRENTE: binds.rec,
            CRIADO_EM: new Date(), ATUALIZADO_EM: new Date(),
          }],
        };
      }
      if (/^SELECT \* FROM contrato_item WHERE id = :id AND contrato_id = :cid/i.test(s)) {
        return { rows: itemRow ? [itemRow] : [] };
      }
      if (/^UPDATE contrato_item SET/i.test(s)) {
        return {
          rows: [{
            ID: binds.id, CONTRATO_ID: binds.cid, TIPO: binds.tipo, DESCRICAO: binds.desc,
            VALOR_UNITARIO_CENTAVOS: binds.valor, QUANTIDADE: binds.qtd, RECORRENTE: binds.rec,
            ATUALIZADO_EM: new Date(),
          }],
        };
      }
      if (/^DELETE FROM contrato_item/i.test(s)) {
        return { rowsAffected: 1, rows: [] };
      }
      if (/^INSERT INTO operador_auditoria/i.test(s)) {
        return { rowsAffected: 1, rows: [] };
      }
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

function auditoriaRegistrada(conn) {
  return conn.cap.filter((c) => /^INSERT INTO operador_auditoria/i.test(c.sql));
}

// ===========================================================================
// Valores em centavos — nunca float.
// ===========================================================================
test('criarOuTrocarContrato rejeita valor recorrente decimal (nunca float)', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, valorRecorrenteCentavos: 1500.5 } }),
    (err) => err.deOperador && err.status === 400 && /inteiro/i.test(err.message)
  );
});

test('criarOuTrocarContrato: valor grande em centavos é gravado e devolvido EXATAMENTE (sem arredondamento)', async () => {
  const conn = conexao();
  db.getConnection = async () => conn;
  const r = await contrato.criarOuTrocarContrato({
    operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, valorRecorrenteCentavos: 123456789 },
  });
  assert.equal(r.valorRecorrenteCentavos, 123456789);
  assert.ok(Number.isInteger(r.valorRecorrenteCentavos), 'o valor devolvido tem que ser inteiro, nunca float');
  const ins = conn.cap.find((c) => /^INSERT INTO contrato/i.test(c.sql));
  assert.equal(ins.binds.valorRecorrenteCentavos, 123456789, 'o valor gravado no banco é o mesmo inteiro, sem conversão');
});

test('criarOuTrocarContrato rejeita ciclo fora da allowlist', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, ciclo: 'semanal' } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('criarOuTrocarContrato rejeita data de início de cobrança mal formatada', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, inicioCobranca: '01/08/2026' } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('criarOuTrocarContrato: 404 se o tenant não existe', async () => {
  db.getConnection = async () => conexao({ tenantExiste: false });
  await assert.rejects(
    contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 999, dados: DADOS_VALIDOS }),
    (err) => err.deOperador && err.status === 404
  );
});

// ===========================================================================
// Trocar de plano encerra o anterior e cria um novo — sem perder histórico.
// ===========================================================================
test('criarOuTrocarContrato: primeiro contrato do tenant (sem anterior) não encerra nada', async () => {
  const conn = conexao({ ativo: null });
  db.getConnection = async () => conn;
  const r = await contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 5, dados: DADOS_VALIDOS });
  assert.equal(r.ativo, true);
  assert.equal(conn.cap.some((c) => /^UPDATE contrato SET fim_vigencia/i.test(c.sql)), false, 'não há contrato anterior para encerrar');
  const aud = auditoriaRegistrada(conn);
  assert.equal(aud.length, 1);
  assert.deepEqual(JSON.parse(aud[0].binds.det).antes, null);
});

test('criarOuTrocarContrato: com um contrato ATIVO, encerra-o (fim_vigencia = hoje) ANTES de inserir o novo', async () => {
  const ativo = { ID: 10, PLANO_NOME: 'Básico', VALOR_RECORRENTE_CENTAVOS: 9900, CICLO: 'mensal', INICIO_COBRANCA: '2020-01-01', FIM_VIGENCIA: null };
  const conn = conexao({ ativo });
  db.getConnection = async () => conn;
  const r = await contrato.criarOuTrocarContrato({
    operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, planoNome: 'Plano Premium', valorRecorrenteCentavos: 250000 },
  });

  const encerra = conn.cap.find((c) => /^UPDATE contrato SET fim_vigencia = :dataLimite WHERE id = :id/i.test(c.sql));
  assert.ok(encerra, 'encerra o contrato anterior');
  assert.equal(encerra.binds.id, 10, 'encerra exatamente o contrato que estava ativo');
  assert.equal(encerra.binds.dataLimite, new Date().toISOString().slice(0, 10), 'início de cobrança bem no passado — encerra hoje');

  const insere = conn.cap.find((c) => /^INSERT INTO contrato/i.test(c.sql));
  const idxEncerra = conn.cap.indexOf(encerra);
  const idxInsere = conn.cap.indexOf(insere);
  assert.ok(idxEncerra < idxInsere, 'encerra o anterior ANTES de inserir o novo (índice único parcial exige isso)');

  assert.equal(r.planoNome, 'Plano Premium');
  assert.equal(r.ativo, true);

  const aud = auditoriaRegistrada(conn);
  assert.equal(aud.length, 1, 'a troca de plano gera UM registro de auditoria');
  const detalhe = JSON.parse(aud[0].binds.det);
  assert.equal(detalhe.antes.contratoId, 10);
  assert.equal(detalhe.antes.planoNome, 'Básico');
  assert.equal(detalhe.antes.valorRecorrenteCentavos, 9900, 'o histórico do que era cobrado antes não é reescrito');
  assert.equal(detalhe.depois.planoNome, 'Plano Premium');
  assert.equal(detalhe.depois.valorRecorrenteCentavos, 250000);
});

test('criarOuTrocarContrato: contrato ativo com início de cobrança FUTURO (ainda em implantação) é encerrado sem violar a vigência', async () => {
  // Achado de review: encerrar com fim_vigencia = CURRENT_DATE (hoje) viola
  // ck_contrato_vigencia (fim_vigencia >= inicio_cobranca) quando a cobrança
  // ainda nem começou — a troca de plano falharia com rollback justo no caso
  // comum de "cliente muda de ideia antes de começar a pagar". A correção usa
  // GREATEST(CURRENT_DATE, inicio_cobranca) — nunca fica antes do início de
  // cobrança do próprio contrato que está sendo encerrado.
  // início de cobrança igual ao do novo contrato (DADOS_VALIDOS): no futuro
  // relativo a hoje, mas não depois do novo — GREATEST(hoje, futuro) = futuro,
  // e o novo contrato (mesma data) ainda passa na validação de não-retroatividade.
  const ativo = { ID: 11, PLANO_NOME: 'Em implantação', VALOR_RECORRENTE_CENTAVOS: 5000, CICLO: 'mensal', INICIO_COBRANCA: DADOS_VALIDOS.inicioCobranca, FIM_VIGENCIA: null };
  const conn = conexao({ ativo });
  db.getConnection = async () => conn;
  await contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 5, dados: DADOS_VALIDOS });

  const encerra = conn.cap.find((c) => /^UPDATE contrato SET fim_vigencia/i.test(c.sql));
  assert.ok(encerra, 'encerra o contrato anterior mesmo com início de cobrança futuro');
  assert.equal(encerra.binds.dataLimite, DADOS_VALIDOS.inicioCobranca, 'nunca fica antes do início de cobrança do próprio contrato que está sendo encerrado');
});

test('criarOuTrocarContrato: rejeita substituto com início de cobrança ANTERIOR ao ponto de encerramento do anterior (achado [P1] da review)', async () => {
  const ativo = { ID: 12, PLANO_NOME: 'Vigente', VALOR_RECORRENTE_CENTAVOS: 9900, CICLO: 'mensal', INICIO_COBRANCA: '2020-01-01', FIM_VIGENCIA: null };
  const conn = conexao({ ativo });
  db.getConnection = async () => conn;
  // O contrato anterior seria encerrado HOJE (início no passado) — um
  // substituto com inicioCobranca no passado tentaria reescrever competência
  // já coberta pelo contrato antigo.
  await assert.rejects(
    contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, inicioCobranca: '2021-06-01' } }),
    (err) => err.deOperador && err.status === 400 && /não pode ser anterior/i.test(err.message)
  );
  assert.equal(conn.cap.some((c) => /^INSERT INTO contrato\s*\(/i.test(c.sql)), false, 'não insere o substituto quando a data é rejeitada');
  assert.equal(conn.cap.some((c) => /^UPDATE contrato SET fim_vigencia/i.test(c.sql)), false, 'não encerra o anterior antes de validar a data do substituto');
});

// ===========================================================================
// Datas de calendário impossíveis — não podem chegar cruas no Postgres.
// ===========================================================================
test('criarOuTrocarContrato rejeita dia impossível dentro do mês (2026-02-31)', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, inicioCobranca: '2026-02-31' } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('criarOuTrocarContrato rejeita mês impossível (2026-99-01)', async () => {
  db.getConnection = async () => conexao();
  await assert.rejects(
    contrato.criarOuTrocarContrato({ operador: OPERADOR, tenantId: 5, dados: { ...DADOS_VALIDOS, inicioCobranca: '2026-99-01' } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('listarContratos: 404 se o tenant não existe', async () => {
  db.getConnection = async () => conexao({ tenantExiste: false });
  await assert.rejects(contrato.listarContratos(999), (err) => err.deOperador && err.status === 404);
});

// ===========================================================================
// Itens do contrato — só no contrato ATIVO; toda mutação é auditada.
// ===========================================================================
const CONTRATO_ATIVO = { ID: 20, TENANT_ID: 5, FIM_VIGENCIA: null };
const CONTRATO_ENCERRADO = { ID: 21, TENANT_ID: 5, FIM_VIGENCIA: '2026-01-01' };
const ITEM_VALIDO = { tipo: 'addon_ia', descricao: 'Add-on de IA', valorUnitarioCentavos: 5000, quantidade: 1, recorrente: true };

test('adicionarItem rejeita tipo fora da allowlist', async () => {
  db.getConnection = async () => conexao({ contratoRow: CONTRATO_ATIVO });
  await assert.rejects(
    contrato.adicionarItem({ operador: OPERADOR, tenantId: 5, contratoId: 20, dados: { ...ITEM_VALIDO, tipo: 'zzz' } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('adicionarItem: item comum (não-desconto) com valor negativo é rejeitado', async () => {
  db.getConnection = async () => conexao({ contratoRow: CONTRATO_ATIVO });
  await assert.rejects(
    contrato.adicionarItem({ operador: OPERADOR, tenantId: 5, contratoId: 20, dados: { ...ITEM_VALIDO, valorUnitarioCentavos: -100 } }),
    (err) => err.deOperador && err.status === 400
  );
});

test('adicionarItem: item de desconto com valor positivo é rejeitado', async () => {
  db.getConnection = async () => conexao({ contratoRow: CONTRATO_ATIVO });
  await assert.rejects(
    contrato.adicionarItem({
      operador: OPERADOR, tenantId: 5, contratoId: 20,
      dados: { tipo: 'desconto', descricao: 'Desconto fidelidade', valorUnitarioCentavos: 500 },
    }),
    (err) => err.deOperador && err.status === 400
  );
});

test('adicionarItem: desconto com valor negativo é aceito', async () => {
  const conn = conexao({ contratoRow: CONTRATO_ATIVO });
  db.getConnection = async () => conn;
  const r = await contrato.adicionarItem({
    operador: OPERADOR, tenantId: 5, contratoId: 20,
    dados: { tipo: 'desconto', descricao: 'Desconto fidelidade', valorUnitarioCentavos: -500 },
  });
  assert.equal(r.valorUnitarioCentavos, -500);
});

test('adicionarItem: contrato encerrado rejeita a mutação (409) — itens são histórico congelado', async () => {
  db.getConnection = async () => conexao({ contratoRow: CONTRATO_ENCERRADO });
  await assert.rejects(
    contrato.adicionarItem({ operador: OPERADOR, tenantId: 5, contratoId: 21, dados: ITEM_VALIDO }),
    (err) => err.deOperador && err.status === 409
  );
});

test('adicionarItem: grava e audita com antes=null/depois={...}', async () => {
  const conn = conexao({ contratoRow: CONTRATO_ATIVO });
  db.getConnection = async () => conn;
  const r = await contrato.adicionarItem({ operador: OPERADOR, tenantId: 5, contratoId: 20, dados: ITEM_VALIDO });
  assert.equal(r.tipo, 'addon_ia');
  assert.equal(r.valorUnitarioCentavos, 5000);
  const aud = auditoriaRegistrada(conn);
  assert.equal(aud.length, 1);
  const detalhe = JSON.parse(aud[0].binds.det);
  assert.equal(detalhe.antes, null);
  assert.equal(detalhe.depois.descricao, 'Add-on de IA');
});

test('atualizarItem: contrato encerrado rejeita a mutação (409)', async () => {
  db.getConnection = async () => conexao({ contratoRow: CONTRATO_ENCERRADO });
  await assert.rejects(
    contrato.atualizarItem({ operador: OPERADOR, tenantId: 5, contratoId: 21, itemId: 1, dados: ITEM_VALIDO }),
    (err) => err.deOperador && err.status === 409
  );
});

test('atualizarItem: audita antes/depois com os valores reais (não reescreve em silêncio)', async () => {
  const itemAntes = { ID: 30, CONTRATO_ID: 20, TIPO: 'addon_ia', DESCRICAO: 'Add-on antigo', VALOR_UNITARIO_CENTAVOS: 3000, QUANTIDADE: 1, RECORRENTE: true };
  const conn = conexao({ contratoRow: CONTRATO_ATIVO, itemRow: itemAntes });
  db.getConnection = async () => conn;
  const r = await contrato.atualizarItem({
    operador: OPERADOR, tenantId: 5, contratoId: 20, itemId: 30,
    dados: { tipo: 'addon_ia', descricao: 'Add-on de IA (reajustado)', valorUnitarioCentavos: 6000, quantidade: 1, recorrente: true },
  });
  assert.equal(r.valorUnitarioCentavos, 6000);
  const aud = auditoriaRegistrada(conn);
  const detalhe = JSON.parse(aud[0].binds.det);
  assert.equal(detalhe.antes.valorUnitarioCentavos, 3000, 'guarda o valor de ANTES da mudança');
  assert.equal(detalhe.depois.valorUnitarioCentavos, 6000);
});

test('removerItem: contrato encerrado rejeita a mutação (409)', async () => {
  db.getConnection = async () => conexao({ contratoRow: CONTRATO_ENCERRADO });
  await assert.rejects(
    contrato.removerItem({ operador: OPERADOR, tenantId: 5, contratoId: 21, itemId: 1 }),
    (err) => err.deOperador && err.status === 409
  );
});

test('removerItem: audita com antes preenchido e depois=null', async () => {
  const itemAntes = { ID: 31, CONTRATO_ID: 20, TIPO: 'numero_extra', DESCRICAO: 'Número extra', VALOR_UNITARIO_CENTAVOS: 2000, QUANTIDADE: 2, RECORRENTE: true };
  const conn = conexao({ contratoRow: CONTRATO_ATIVO, itemRow: itemAntes });
  db.getConnection = async () => conn;
  const r = await contrato.removerItem({ operador: OPERADOR, tenantId: 5, contratoId: 20, itemId: 31 });
  assert.deepEqual(r, { ok: true });
  const aud = auditoriaRegistrada(conn);
  const detalhe = JSON.parse(aud[0].binds.det);
  assert.equal(detalhe.antes.descricao, 'Número extra');
  assert.equal(detalhe.depois, null);
});

test('listarItens: 404 se o contrato não pertence ao tenant informado', async () => {
  db.getConnection = async () => conexao({ contratoRow: null });
  await assert.rejects(
    contrato.listarItens({ tenantId: 5, contratoId: 999 }),
    (err) => err.deOperador && err.status === 404
  );
});

// ===========================================================================
// listarContratosVigentes (FIL-82) — cross-tenant, "Contratos" no menu.
// ===========================================================================
function conexaoVigentes({ linhas = [] } = {}) {
  return {
    async execute(sql) {
      if (/FROM tenant t\s+LEFT JOIN contrato c/i.test(sql)) return { rows: linhas };
      return { rows: [] };
    },
    commit: async () => {}, rollback: async () => {}, close: async () => {},
  };
}

test('listarContratosVigentes: cliente sem contrato ativo aparece com campos de contrato em null', async () => {
  db.getConnection = async () => conexaoVigentes({
    linhas: [{
      TENANT_ID: 1, TENANT_NOME: 'Sem Contrato', TENANT_SLUG: 'sem-contrato', TENANT_STATUS: 'ativo',
      CONTRATO_ID: null, PLANO_NOME: null, VALOR_RECORRENTE_CENTAVOS: null, CICLO: null,
      DIA_VENCIMENTO: null, INICIO_COBRANCA: null,
    }],
  });
  const r = await contrato.listarContratosVigentes();
  assert.equal(r.length, 1);
  assert.equal(r[0].tenantNome, 'Sem Contrato');
  assert.equal(r[0].contratoId, null);
  assert.equal(r[0].planoNome, null);
  assert.equal(r[0].valorRecorrenteCentavos, null);
});

test('listarContratosVigentes: traduz os campos do contrato ativo (centavos como inteiro, sem deslocar a data)', async () => {
  db.getConnection = async () => conexaoVigentes({
    linhas: [{
      TENANT_ID: 2, TENANT_NOME: 'Com Contrato', TENANT_SLUG: 'com-contrato', TENANT_STATUS: 'suspenso',
      CONTRATO_ID: 55, PLANO_NOME: 'Plano Pro', VALOR_RECORRENTE_CENTAVOS: '150000', CICLO: 'mensal',
      DIA_VENCIMENTO: 10, INICIO_COBRANCA: new Date(2026, 0, 1), // Date local (mesma armadilha do pg-types)
      REAJUSTE_INDICE: 'IPCA', REAJUSTE_MES: 1, OBSERVACOES: 'contrato piloto',
    }],
  });
  const r = await contrato.listarContratosVigentes();
  assert.equal(r[0].contratoId, 55);
  assert.ok(Number.isInteger(r[0].valorRecorrenteCentavos));
  assert.equal(r[0].valorRecorrenteCentavos, 150000);
  assert.equal(r[0].ciclo, 'mensal');
  assert.equal(r[0].diaVencimento, 10);
  assert.equal(r[0].inicioCobranca, '2026-01-01', 'data local não pode deslocar pra 2025-12-31 (UTC)');
  assert.equal(r[0].reajusteIndice, 'IPCA');
  assert.equal(r[0].reajusteMes, 1);
  assert.equal(r[0].observacoes, 'contrato piloto');
  assert.equal(r[0].tenantStatus, 'suspenso');
});
