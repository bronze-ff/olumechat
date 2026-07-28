// operador/fatura.js — faturamento, pagamentos e inadimplência (FIL-79). SÓ o
// operador vê isto (ver docs/SEGURANCA.md); as tabelas são FECHADAS para o
// caminho de tenant (migração 019, mesmo padrão de `contrato`/018).
//
// A GERAÇÃO em si (o que compõe a fatura) vive em financeiro/faturamento.js —
// aqui é só o CRUD de operador em cima do que já foi gerado: consultar,
// emitir, cancelar, ajustar item avulso antes de emitir, registrar pagamento,
// listar inadimplência.
//
// ── FATURA CONGELADA ─────────────────────────────────────────────────────
// Nenhuma função aqui recalcula `valor_total_centavos` a partir do contrato —
// só a partir da SOMA dos itens já gravados (que só mudam enquanto a fatura
// ainda é `prevista`, ver exigirPrevista). Depois de `emitida`, os itens são
// histórico imutável — nem este módulo escreve neles.
'use strict';

const { comOperador } = require('./db');
const auditoria = require('./auditoria');
const { ErroOperador } = require('./erroOperador');
const { mapRow, mapRows } = require('../utils/linhas');
const faturamento = require('../financeiro/faturamento');

const TIPOS_ITEM_MANUAL = Object.freeze(['avulso', 'desconto']);
const MEIOS_PAGAMENTO = Object.freeze(['pix', 'boleto', 'transferencia', 'cartao']);
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_COMPETENCIA = /^\d{4}-\d{2}$/;

function inteiro(v, nomeCampo, { min, max } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ErroOperador(400, `${nomeCampo} deve ser um número inteiro (centavos, nunca decimal).`);
  if (min !== undefined && n < min) throw new ErroOperador(400, `${nomeCampo} não pode ser menor que ${min}.`);
  if (max !== undefined && n > max) throw new ErroOperador(400, `${nomeCampo} não pode ser maior que ${max}.`);
  return n;
}

function validarData(v, nomeCampo) {
  const s = String(v || '');
  if (!RE_DATA.test(s)) throw new ErroOperador(400, `${nomeCampo} inválida — use AAAA-MM-DD.`);
  return s;
}

function textoObrigatorio(v, nomeCampo, max) {
  const s = String(v || '').trim();
  if (!s) throw new ErroOperador(400, `${nomeCampo} é obrigatório.`);
  if (s.length > max) throw new ErroOperador(400, `${nomeCampo} não pode passar de ${max} caracteres.`);
  return s;
}

function textoOpcional(v, max) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

async function carregarTenant(conn, tenantId) {
  const r = await conn.execute(`SELECT id FROM tenant WHERE id = :id`, { id: tenantId });
  if (!r.rows.length) throw new ErroOperador(404, 'Tenant não encontrado.');
}

async function carregarFatura(conn, tenantId, faturaId) {
  const r = await conn.execute(
    `SELECT * FROM fatura WHERE id = :id AND tenant_id = :tid`,
    { id: faturaId, tid: tenantId }
  );
  if (!r.rows.length) throw new ErroOperador(404, 'Fatura não encontrada.');
  return r.rows[0];
}

/**
 * Mesma fatura, mas com `FOR UPDATE` (achado de review do PR #26): sem o
 * lock, dois pagamentos concorrentes na MESMA fatura liam o mesmo saldo antes
 * de qualquer um dos dois commitar — os dois passavam na validação "valor <=
 * saldo" e a soma dos dois podia ultrapassar o total da fatura. `FOR UPDATE`
 * serializa: a segunda requisição espera o commit/rollback da primeira antes
 * de ler a linha, então vê o saldo já atualizado. Só usada onde o saldo é
 * lido e gravado na MESMA transação (registrarPagamento) — leitura pura
 * (obterFatura, listarFaturas) continua sem lock.
 */
async function carregarFaturaTravada(conn, tenantId, faturaId) {
  const r = await conn.execute(
    `SELECT * FROM fatura WHERE id = :id AND tenant_id = :tid FOR UPDATE`,
    { id: faturaId, tid: tenantId }
  );
  if (!r.rows.length) throw new ErroOperador(404, 'Fatura não encontrada.');
  return r.rows[0];
}

function exigirPrevista(fatura) {
  if (fatura.STATUS !== 'prevista') {
    throw new ErroOperador(409, 'Fatura já emitida — os itens são histórico congelado, não podem ser alterados.');
  }
}

async function somarItens(conn, faturaId) {
  const r = await conn.execute(
    `SELECT COALESCE(SUM(valor_total_centavos), 0) AS total FROM fatura_item WHERE fatura_id = :id`,
    { id: faturaId }
  );
  return Number((r.rows[0] || {}).TOTAL || 0);
}

async function recalcularTotal(conn, faturaId) {
  const total = await somarItens(conn, faturaId);
  await conn.execute(
    `UPDATE fatura SET valor_total_centavos = :total, atualizado_em = now() WHERE id = :id`,
    { total, id: faturaId }
  );
  return total;
}

async function saldoDaFatura(conn, fatura) {
  const r = await conn.execute(
    `SELECT COALESCE(SUM(valor_centavos), 0) AS pago FROM pagamento WHERE fatura_id = :id`,
    { id: fatura.ID }
  );
  const pago = Number((r.rows[0] || {}).PAGO || 0);
  return Number(fatura.VALOR_TOTAL_CENTAVOS) - pago;
}

function linhaFatura(row) {
  return mapRow(row);
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/** Histórico de faturas do tenant, mais recente primeiro. */
async function listarFaturas(tenantId) {
  return comOperador(async (conn) => {
    await carregarTenant(conn, tenantId);
    const r = await conn.execute(
      `SELECT * FROM fatura WHERE tenant_id = :tid ORDER BY competencia DESC, id DESC`,
      { tid: tenantId }
    );
    return mapRows(r.rows);
  });
}

/** Uma fatura com itens, pagamentos e saldo. */
async function obterFatura({ tenantId, faturaId }) {
  return comOperador(async (conn) => {
    const fatura = await carregarFatura(conn, tenantId, faturaId);
    const itens = await conn.execute(
      `SELECT * FROM fatura_item WHERE fatura_id = :id ORDER BY criado_em, id`,
      { id: faturaId }
    );
    const pagamentos = await conn.execute(
      `SELECT * FROM pagamento WHERE fatura_id = :id ORDER BY data_pagamento, id`,
      { id: faturaId }
    );
    const saldoCentavos = await saldoDaFatura(conn, fatura);
    return {
      ...linhaFatura(fatura),
      itens: mapRows(itens.rows),
      pagamentos: mapRows(pagamentos.rows),
      saldoCentavos,
    };
  });
}

/** Faturas `atrasada` de todos os tenants — o operador decide se suspende (nunca automático). */
async function listarInadimplencia() {
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `SELECT f.*, t.nome AS tenant_nome, t.slug AS tenant_slug, t.status AS tenant_status,
              (CURRENT_DATE - f.vencimento) AS dias_vencida
         FROM fatura f
         JOIN tenant t ON t.id = f.tenant_id
        WHERE f.status = 'atrasada'
        ORDER BY f.vencimento`
    );
    return r.rows.map((row) => ({
      ...mapRow(row),
      sugereSuspensao: true,
    }));
  });
}

// ---------------------------------------------------------------------------
// Geração manual (a automática roda em financeiro/faturamento.js::tick)
// ---------------------------------------------------------------------------

async function gerarManual({ operador, competencia, tenantId, ip }) {
  const comp = competencia ? String(competencia) : faturamento.anoMesAtual();
  if (!RE_COMPETENCIA.test(comp)) throw new ErroOperador(400, 'Competência inválida — use AAAA-MM.');
  return comOperador(async (conn) => {
    if (tenantId) await carregarTenant(conn, tenantId);
    const geradas = await faturamento.gerarFaturas(conn, comp, { tenantId, operador });
    await auditoria.registrar(conn, {
      operador, tenantId: tenantId || null, acao: 'fatura_geracao_manual', entidade: 'fatura',
      detalhe: { competencia: comp, faturasGeradas: geradas.length },
      ip,
    });
    return { competencia: comp, faturasGeradas: geradas.length };
  });
}

// ---------------------------------------------------------------------------
// Itens manuais (avulso/desconto) — só enquanto a fatura é `prevista`.
// ---------------------------------------------------------------------------

function validarItemManual(dados) {
  const tipo = String(dados.tipo || '');
  if (!TIPOS_ITEM_MANUAL.includes(tipo)) throw new ErroOperador(400, `Tipo de item inválido (use: ${TIPOS_ITEM_MANUAL.join(', ')}).`);
  const descricao = textoObrigatorio(dados.descricao, 'Descrição do item', 200);
  const valorUnitarioCentavos = inteiro(dados.valorUnitarioCentavos, 'Valor unitário');
  if (tipo === 'desconto' && valorUnitarioCentavos > 0) {
    throw new ErroOperador(400, 'Item de desconto deve ter valor negativo ou zero.');
  }
  if (tipo !== 'desconto' && valorUnitarioCentavos < 0) {
    throw new ErroOperador(400, 'Só item do tipo "desconto" pode ter valor negativo.');
  }
  const quantidade = dados.quantidade === undefined ? 1 : inteiro(dados.quantidade, 'Quantidade', { min: 1 });
  return { tipo, descricao, valorUnitarioCentavos, quantidade };
}

async function adicionarItem({ operador, tenantId, faturaId, dados, ip }) {
  const v = validarItemManual(dados);
  return comOperador(async (conn) => {
    const fatura = await carregarFatura(conn, tenantId, faturaId);
    exigirPrevista(fatura);
    const valorTotal = v.quantidade * v.valorUnitarioCentavos;
    const ins = await conn.execute(
      `INSERT INTO fatura_item (fatura_id, tipo, descricao, quantidade, valor_unitario_centavos, valor_total_centavos)
       VALUES (:faturaId, :tipo, :descricao, :quantidade, :valorUnitario, :valorTotal)
       RETURNING *`,
      { faturaId, tipo: v.tipo, descricao: v.descricao, quantidade: v.quantidade, valorUnitario: v.valorUnitarioCentavos, valorTotal }
    );
    const item = ins.rows[0];
    const total = await recalcularTotal(conn, faturaId);
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'fatura_item_adicionado', entidade: 'fatura_item', entidadeId: Number(item.ID),
      detalhe: { faturaId, antes: null, depois: v, valorTotalFatura: total },
      ip,
    });
    return mapRow(item);
  });
}

async function removerItem({ operador, tenantId, faturaId, itemId, ip }) {
  return comOperador(async (conn) => {
    const fatura = await carregarFatura(conn, tenantId, faturaId);
    exigirPrevista(fatura);
    const r = await conn.execute(
      `SELECT * FROM fatura_item WHERE id = :id AND fatura_id = :fid`,
      { id: itemId, fid: faturaId }
    );
    if (!r.rows.length) throw new ErroOperador(404, 'Item não encontrado.');
    const antes = r.rows[0];
    await conn.execute(`DELETE FROM fatura_item WHERE id = :id AND fatura_id = :fid`, { id: itemId, fid: faturaId });
    const total = await recalcularTotal(conn, faturaId);
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'fatura_item_removido', entidade: 'fatura_item', entidadeId: Number(itemId),
      detalhe: {
        faturaId,
        antes: { tipo: antes.TIPO, descricao: antes.DESCRICAO, valorTotalCentavos: Number(antes.VALOR_TOTAL_CENTAVOS) },
        depois: null, valorTotalFatura: total,
      },
      ip,
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

/** `prevista` → `emitida`. Não bloqueia por `custo_incerto` — só sinaliza (a
 *  decisão de emitir mesmo assim é do operador, ver financeiro/faturamento.js). */
async function emitirFatura({ operador, tenantId, faturaId, ip }) {
  return comOperador(async (conn) => {
    const fatura = await carregarFatura(conn, tenantId, faturaId);
    if (fatura.STATUS !== 'prevista') throw new ErroOperador(409, `Fatura no status "${fatura.STATUS}" não pode ser emitida.`);
    const upd = await conn.execute(
      `UPDATE fatura SET status = 'emitida', emitida_em = now(), atualizado_em = now() WHERE id = :id RETURNING *`,
      { id: faturaId }
    );
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'fatura_emitida', entidade: 'fatura', entidadeId: faturaId,
      detalhe: { custoIncerto: fatura.CUSTO_INCERTO === true, valorTotalCentavos: Number(fatura.VALOR_TOTAL_CENTAVOS) },
      ip,
    });
    return linhaFatura(upd.rows[0]);
  });
}

async function cancelarFatura({ operador, tenantId, faturaId, motivo, ip }) {
  return comOperador(async (conn) => {
    const fatura = await carregarFatura(conn, tenantId, faturaId);
    if (['paga', 'cancelada'].includes(fatura.STATUS)) {
      throw new ErroOperador(409, `Fatura no status "${fatura.STATUS}" não pode ser cancelada.`);
    }
    const pg = await conn.execute(`SELECT COUNT(*) AS cnt FROM pagamento WHERE fatura_id = :id`, { id: faturaId });
    if (Number((pg.rows[0] || {}).CNT || 0) > 0) {
      throw new ErroOperador(409, 'Fatura tem pagamento registrado — não pode ser cancelada.');
    }
    const upd = await conn.execute(
      `UPDATE fatura SET status = 'cancelada', atualizado_em = now() WHERE id = :id RETURNING *`,
      { id: faturaId }
    );
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'fatura_cancelada', entidade: 'fatura', entidadeId: faturaId,
      detalhe: { de: fatura.STATUS, motivo: motivo || null },
      ip,
    });
    return linhaFatura(upd.rows[0]);
  });
}

/** Marca a fatura como em negociação com o cliente inadimplente (não fecha, não cancela). */
async function marcarEmNegociacao({ operador, tenantId, faturaId, motivo, ip }) {
  return comOperador(async (conn) => {
    const fatura = await carregarFatura(conn, tenantId, faturaId);
    if (!['emitida', 'atrasada'].includes(fatura.STATUS)) {
      throw new ErroOperador(409, `Fatura no status "${fatura.STATUS}" não pode ir para negociação.`);
    }
    const upd = await conn.execute(
      `UPDATE fatura SET status = 'em_negociacao', atualizado_em = now() WHERE id = :id RETURNING *`,
      { id: faturaId }
    );
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'fatura_em_negociacao', entidade: 'fatura', entidadeId: faturaId,
      detalhe: { de: fatura.STATUS, motivo: motivo || null },
      ip,
    });
    return linhaFatura(upd.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Pagamento — parcial mantém saldo aberto; total fecha a fatura.
// ---------------------------------------------------------------------------

function validarPagamento(dados) {
  const valorCentavos = inteiro(dados.valorCentavos, 'Valor do pagamento', { min: 1 });
  const data = validarData(dados.data, 'Data do pagamento');
  const meio = String(dados.meio || '');
  if (!MEIOS_PAGAMENTO.includes(meio)) throw new ErroOperador(400, `Meio de pagamento inválido (use: ${MEIOS_PAGAMENTO.join(', ')}).`);
  const comprovante = textoOpcional(dados.comprovante, 2000);
  return { valorCentavos, data, meio, comprovante };
}

async function registrarPagamento({ operador, tenantId, faturaId, dados, ip }) {
  const v = validarPagamento(dados);
  return comOperador(async (conn) => {
    const fatura = await carregarFaturaTravada(conn, tenantId, faturaId);
    if (!['emitida', 'atrasada', 'em_negociacao'].includes(fatura.STATUS)) {
      throw new ErroOperador(409, `Fatura no status "${fatura.STATUS}" não aceita pagamento.`);
    }
    const saldoAntes = await saldoDaFatura(conn, fatura);
    if (v.valorCentavos > saldoAntes) {
      throw new ErroOperador(400, `Valor maior que o saldo devido (${saldoAntes} centavos).`);
    }
    const ins = await conn.execute(
      `INSERT INTO pagamento (fatura_id, valor_centavos, data_pagamento, meio, comprovante, registrado_por)
       VALUES (:faturaId, :valor, :data, :meio, :comprovante, :registradoPor)
       RETURNING *`,
      { faturaId, valor: v.valorCentavos, data: v.data, meio: v.meio, comprovante: v.comprovante, registradoPor: operador.id }
    );
    const pagamento = ins.rows[0];
    const saldoDepois = saldoAntes - v.valorCentavos;
    let statusFinal = fatura.STATUS;
    if (saldoDepois === 0) {
      statusFinal = 'paga';
      await conn.execute(
        `UPDATE fatura SET status = 'paga', paga_em = now(), atualizado_em = now() WHERE id = :id`,
        { id: faturaId }
      );
    }
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'pagamento_registrado', entidade: 'pagamento', entidadeId: Number(pagamento.ID),
      detalhe: { faturaId, valorCentavos: v.valorCentavos, meio: v.meio, saldoAntes, saldoDepois, statusFinal },
      ip,
    });
    return { pagamento: mapRow(pagamento), saldoCentavos: saldoDepois, status: statusFinal };
  });
}

async function listarPagamentos({ tenantId, faturaId }) {
  return comOperador(async (conn) => {
    await carregarFatura(conn, tenantId, faturaId);
    const r = await conn.execute(
      `SELECT * FROM pagamento WHERE fatura_id = :id ORDER BY data_pagamento, id`,
      { id: faturaId }
    );
    return mapRows(r.rows);
  });
}

module.exports = {
  TIPOS_ITEM_MANUAL, MEIOS_PAGAMENTO,
  listarFaturas, obterFatura, listarInadimplencia, gerarManual,
  adicionarItem, removerItem,
  emitirFatura, cancelarFatura, marcarEmNegociacao,
  registrarPagamento, listarPagamentos,
};
