// operador/implementacao.js — projeto de entrada do cliente (FIL-76): valor,
// forma de pagamento, status, datas. Ligado ao TENANT (não ao contrato) — o
// projeto de implantação sobrevive a uma troca de plano posterior. Mesma
// tabela fechada para o caminho de tenant que `contrato` (migração 018) — ver
// docs/SEGURANCA.md.
//
// ── TERMOS FINANCEIROS TRAVAM DEPOIS DA 1ª PARCELA (FIL-79, achado de review
// do PR #26) ─────────────────────────────────────────────────────────────
// financeiro/faturamento.js deriva a PRÓXIMA parcela a cobrar contando
// quantos fatura_item (origem_tipo='implementacao') já existem — não do
// numero_parcelas atual. Editar valorCentavos/formaPagamento/numeroParcelas
// depois que a 1ª parcela (não cancelada) foi faturada desalinha essa conta:
// ex. 3.333 já cobrado de um setup de 10.000/3, o operador muda o valor para
// 12.000 → as próximas parcelas recalculam em cima de 12.000/3, e a soma
// (3.333 + 4.000 + 4.000 = 11.333) nunca bate nem o valor antigo nem o novo.
// Por isso atualizarImplementacao rejeita mudar esses três campos assim que
// existe parcela faturada — status/datas/responsável continuam livres.
'use strict';

const { comOperador } = require('./db');
const auditoria = require('./auditoria');
const { ErroOperador } = require('./erroOperador');
const { mapRow } = require('../utils/linhas');
const { validarDataYYYYMMDD } = require('../utils/data');

const FORMAS_PAGAMENTO = Object.freeze(['a_vista', 'parcelado']);
const STATUS = Object.freeze(['a_iniciar', 'em_andamento', 'entregue']);

function inteiro(v, nomeCampo, { min, max } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ErroOperador(400, `${nomeCampo} deve ser um número inteiro (centavos, nunca decimal).`);
  if (min !== undefined && n < min) throw new ErroOperador(400, `${nomeCampo} não pode ser menor que ${min}.`);
  if (max !== undefined && n > max) throw new ErroOperador(400, `${nomeCampo} não pode ser maior que ${max}.`);
  return n;
}

function validarDataOpcional(v, nomeCampo) {
  if (v === undefined || v === null || v === '') return null;
  return validarDataYYYYMMDD(v, nomeCampo, ErroOperador);
}

function textoOpcional(v, max) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** Valida os campos de uma implementação (merge com o valor atual em updates parciais). */
function validarImplementacao(dados) {
  const valorCentavos = inteiro(dados.valorCentavos, 'Valor da implementação', { min: 0 });
  const formaPagamento = String(dados.formaPagamento || '');
  if (!FORMAS_PAGAMENTO.includes(formaPagamento)) {
    throw new ErroOperador(400, `Forma de pagamento inválida (use: ${FORMAS_PAGAMENTO.join(', ')}).`);
  }
  let numeroParcelas = null;
  if (formaPagamento === 'parcelado') {
    numeroParcelas = inteiro(dados.numeroParcelas, 'Número de parcelas', { min: 2 });
  } else if (dados.numeroParcelas !== undefined && dados.numeroParcelas !== null && Number(dados.numeroParcelas) !== 1) {
    throw new ErroOperador(400, 'Implementação à vista não tem número de parcelas (ou use 1).');
  }
  const status = dados.status === undefined ? 'a_iniciar' : String(dados.status);
  if (!STATUS.includes(status)) throw new ErroOperador(400, `Status inválido (use: ${STATUS.join(', ')}).`);
  const dataPrevista = validarDataOpcional(dados.dataPrevista, 'Data prevista');
  const dataEntrega = validarDataOpcional(dados.dataEntrega, 'Data de entrega');
  if (status === 'entregue' && !dataEntrega) {
    throw new ErroOperador(400, 'Status "entregue" exige data de entrega.');
  }
  const responsavel = textoOpcional(dados.responsavel, 120);
  return { valorCentavos, formaPagamento, numeroParcelas, status, dataPrevista, dataEntrega, responsavel };
}

async function carregarTenant(conn, tenantId) {
  const r = await conn.execute(`SELECT id FROM tenant WHERE id = :id`, { id: tenantId });
  if (!r.rows.length) throw new ErroOperador(404, 'Tenant não encontrado.');
}

/** A implementação mais recente do tenant (ou null, se ainda não existe nenhuma). */
async function obterImplementacao(tenantId) {
  return comOperador(async (conn) => {
    await carregarTenant(conn, tenantId);
    const r = await conn.execute(
      `SELECT * FROM implementacao WHERE tenant_id = :tid ORDER BY criado_em DESC, id DESC LIMIT 1`,
      { tid: tenantId }
    );
    return r.rows.length ? mapRow(r.rows[0]) : null;
  });
}

async function criarImplementacao({ operador, tenantId, dados, ip }) {
  const v = validarImplementacao(dados);
  return comOperador(async (conn) => {
    await carregarTenant(conn, tenantId);
    const ins = await conn.execute(
      `INSERT INTO implementacao
         (tenant_id, valor_centavos, forma_pagamento, numero_parcelas, status, data_prevista, data_entrega, responsavel, criado_por)
       VALUES
         (:tenantId, :valor, :forma, :parcelas, :status, :dataPrevista, :dataEntrega, :responsavel, :criadoPor)
       RETURNING *`,
      {
        tenantId, valor: v.valorCentavos, forma: v.formaPagamento, parcelas: v.numeroParcelas,
        status: v.status, dataPrevista: v.dataPrevista, dataEntrega: v.dataEntrega,
        responsavel: v.responsavel, criadoPor: operador.id,
      }
    );
    const nova = ins.rows[0];
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'implementacao_criada', entidade: 'implementacao', entidadeId: Number(nova.ID),
      detalhe: { antes: null, depois: v },
      ip,
    });
    return mapRow(nova);
  });
}

async function carregarImplementacaoDoTenant(conn, tenantId, implementacaoId) {
  const r = await conn.execute(
    `SELECT * FROM implementacao WHERE id = :id AND tenant_id = :tid`,
    { id: implementacaoId, tid: tenantId }
  );
  if (!r.rows.length) throw new ErroOperador(404, 'Implementação não encontrada.');
  return r.rows[0];
}

/** Parcelas já faturadas desta implementação — EXCLUI as que só existem numa
 *  fatura `cancelada` (mesmo critério de financeiro/faturamento.js::parcelasJaFaturadas). */
async function parcelasJaFaturadas(conn, implementacaoId) {
  const r = await conn.execute(
    `SELECT COUNT(*) AS cnt
       FROM fatura_item fi
       JOIN fatura f ON f.id = fi.fatura_id
      WHERE fi.origem_tipo = 'implementacao' AND fi.origem_id = :id AND f.status <> 'cancelada'`,
    { id: implementacaoId }
  );
  return Number((r.rows[0] || {}).CNT || 0);
}

function snapshot(row) {
  return {
    valorCentavos: Number(row.VALOR_CENTAVOS), formaPagamento: row.FORMA_PAGAMENTO,
    numeroParcelas: row.NUMERO_PARCELAS === null ? null : Number(row.NUMERO_PARCELAS),
    status: row.STATUS, dataPrevista: row.DATA_PREVISTA, dataEntrega: row.DATA_ENTREGA,
    responsavel: row.RESPONSAVEL,
  };
}

/** Atualização em bloco (edita o projeto em andamento) — auditada com antes/depois. */
async function atualizarImplementacao({ operador, tenantId, implementacaoId, dados, ip }) {
  return comOperador(async (conn) => {
    const antes = await carregarImplementacaoDoTenant(conn, tenantId, implementacaoId);
    const merge = {
      valorCentavos: dados.valorCentavos !== undefined ? dados.valorCentavos : Number(antes.VALOR_CENTAVOS),
      formaPagamento: dados.formaPagamento !== undefined ? dados.formaPagamento : antes.FORMA_PAGAMENTO,
      numeroParcelas: dados.numeroParcelas !== undefined ? dados.numeroParcelas
        : (antes.NUMERO_PARCELAS === null ? null : Number(antes.NUMERO_PARCELAS)),
      status: dados.status !== undefined ? dados.status : antes.STATUS,
      dataPrevista: dados.dataPrevista !== undefined ? dados.dataPrevista : antes.DATA_PREVISTA,
      dataEntrega: dados.dataEntrega !== undefined ? dados.dataEntrega : antes.DATA_ENTREGA,
      responsavel: dados.responsavel !== undefined ? dados.responsavel : antes.RESPONSAVEL,
    };
    const v = validarImplementacao(merge);

    const termosMudaram = v.valorCentavos !== Number(antes.VALOR_CENTAVOS)
      || v.formaPagamento !== antes.FORMA_PAGAMENTO
      || v.numeroParcelas !== (antes.NUMERO_PARCELAS === null ? null : Number(antes.NUMERO_PARCELAS));
    if (termosMudaram && (await parcelasJaFaturadas(conn, implementacaoId)) > 0) {
      throw new ErroOperador(409, 'Valor, forma de pagamento ou número de parcelas não podem mudar depois que o faturamento já começou.');
    }

    const upd = await conn.execute(
      `UPDATE implementacao
          SET valor_centavos = :valor, forma_pagamento = :forma, numero_parcelas = :parcelas,
              status = :status, data_prevista = :dataPrevista, data_entrega = :dataEntrega,
              responsavel = :responsavel, atualizado_em = now()
        WHERE id = :id AND tenant_id = :tid
        RETURNING *`,
      {
        valor: v.valorCentavos, forma: v.formaPagamento, parcelas: v.numeroParcelas, status: v.status,
        dataPrevista: v.dataPrevista, dataEntrega: v.dataEntrega, responsavel: v.responsavel,
        id: implementacaoId, tid: tenantId,
      }
    );
    const depois = upd.rows[0];
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'implementacao_atualizada', entidade: 'implementacao', entidadeId: Number(implementacaoId),
      detalhe: { antes: snapshot(antes), depois: v },
      ip,
    });
    return mapRow(depois);
  });
}

module.exports = {
  FORMAS_PAGAMENTO, STATUS,
  obterImplementacao, criarImplementacao, atualizarImplementacao, validarImplementacao,
};
