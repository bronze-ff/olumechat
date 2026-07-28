// operador/contrato.js — contrato comercial por cliente (FIL-76): plano,
// recorrência, implementação. Base do módulo financeiro — responde "quanto
// esse cliente paga, desde quando, e pelo quê". SÓ o operador vê isto (ver
// docs/SEGURANCA.md); as tabelas são FECHADAS para o caminho de tenant (migração
// 018, mesmo padrão de `provedor_credencial`/015).
//
// CROSS-TENANT DE PROPÓSITO (comOperador): mesmo racional de operador/tenants.js
// — dentro de comOperador() não existe rede de segurança de RLS, então toda
// query nomeia tenant_id/contrato_id explicitamente.
//
// ── TROCAR DE PLANO NUNCA SOBRESCREVE ───────────────────────────────────────
// `criarOuTrocarContrato` é o ÚNICO jeito de gravar um `contrato`: não existe
// UPDATE de plano/valor num contrato existente. Se já há um contrato ATIVO
// (fim_vigencia IS NULL) para o tenant, ele é encerrado (fim_vigencia = hoje)
// e uma linha NOVA é inserida — o índice único parcial (ux_contrato_ativo_unico)
// garante que nunca há dois ativos ao mesmo tempo. O histórico do que foi
// cobrado nunca é reescrito.
//
// ── ITENS SÓ SE MEXEM NO CONTRATO ATIVO ─────────────────────────────────────
// Um item (contrato_item) só pode ser criado/editado/removido enquanto o
// contrato dono ainda está ativo. Trocar de plano "congela" os itens do
// contrato antigo junto com o resto do histórico — o operador precisa
// recriá-los explicitamente no contrato novo, se ainda fizerem sentido.
'use strict';

const { comOperador } = require('./db');
const auditoria = require('./auditoria');
const { ErroOperador } = require('./erroOperador');
const { mapRow, mapRows } = require('../utils/linhas');
const { validarDataYYYYMMDD } = require('../utils/data');

const CICLOS = Object.freeze(['mensal', 'trimestral', 'anual']);
const TIPOS_ITEM = Object.freeze(['implementacao', 'addon_ia', 'numero_extra', 'excedente_mensagem', 'desconto', 'avulso']);

/** Inteiro seguro (centavos nunca são float). */
function inteiro(v, nomeCampo, { min, max } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ErroOperador(400, `${nomeCampo} deve ser um número inteiro (centavos, nunca decimal).`);
  if (min !== undefined && n < min) throw new ErroOperador(400, `${nomeCampo} não pode ser menor que ${min}.`);
  if (max !== undefined && n > max) throw new ErroOperador(400, `${nomeCampo} não pode ser maior que ${max}.`);
  return n;
}

function validarData(v, nomeCampo) {
  return validarDataYYYYMMDD(v, nomeCampo, ErroOperador);
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

/**
 * Valida os campos de um contrato novo (plano + recorrência). Lança
 * ErroOperador(400) na primeira regra violada.
 */
function validarNovoContrato(dados) {
  const planoNome = textoObrigatorio(dados.planoNome, 'Nome do plano', 120);
  const valorRecorrenteCentavos = inteiro(dados.valorRecorrenteCentavos, 'Valor recorrente', { min: 0 });
  const ciclo = String(dados.ciclo || '');
  if (!CICLOS.includes(ciclo)) throw new ErroOperador(400, `Ciclo inválido (use: ${CICLOS.join(', ')}).`);
  const diaVencimento = inteiro(dados.diaVencimento, 'Dia de vencimento', { min: 1, max: 28 });
  const inicioCobranca = validarData(dados.inicioCobranca, 'Início da cobrança');
  const reajusteIndice = textoOpcional(dados.reajusteIndice, 20);
  const reajusteMes = (dados.reajusteMes === undefined || dados.reajusteMes === null || dados.reajusteMes === '')
    ? null : inteiro(dados.reajusteMes, 'Mês de reajuste', { min: 1, max: 12 });
  const observacoes = textoOpcional(dados.observacoes, 2000);
  return { planoNome, valorRecorrenteCentavos, ciclo, diaVencimento, inicioCobranca, reajusteIndice, reajusteMes, observacoes };
}

function validarItem(dados) {
  const tipo = String(dados.tipo || '');
  if (!TIPOS_ITEM.includes(tipo)) throw new ErroOperador(400, `Tipo de item inválido (use: ${TIPOS_ITEM.join(', ')}).`);
  const descricao = textoObrigatorio(dados.descricao, 'Descrição do item', 200);
  const valorUnitarioCentavos = inteiro(dados.valorUnitarioCentavos, 'Valor unitário');
  if (tipo === 'desconto' && valorUnitarioCentavos > 0) {
    throw new ErroOperador(400, 'Item de desconto deve ter valor negativo ou zero.');
  }
  if (tipo !== 'desconto' && valorUnitarioCentavos < 0) {
    throw new ErroOperador(400, 'Só item do tipo "desconto" pode ter valor negativo.');
  }
  const quantidade = dados.quantidade === undefined ? 1 : inteiro(dados.quantidade, 'Quantidade', { min: 1 });
  const recorrente = dados.recorrente === true;
  return { tipo, descricao, valorUnitarioCentavos, quantidade, recorrente };
}

function linhaContrato(row) {
  const r = mapRow(row);
  r.ativo = r.fimVigencia === null || r.fimVigencia === undefined;
  return r;
}

async function carregarTenant(conn, tenantId) {
  const r = await conn.execute(`SELECT id FROM tenant WHERE id = :id`, { id: tenantId });
  if (!r.rows.length) throw new ErroOperador(404, 'Tenant não encontrado.');
}

async function carregarContratoAtivo(conn, tenantId) {
  const r = await conn.execute(
    `SELECT id, plano_nome, valor_recorrente_centavos, ciclo, fim_vigencia
       FROM contrato WHERE tenant_id = :tid AND fim_vigencia IS NULL`,
    { tid: tenantId }
  );
  return r.rows[0] || null;
}

async function carregarContrato(conn, tenantId, contratoId) {
  const r = await conn.execute(
    `SELECT * FROM contrato WHERE id = :id AND tenant_id = :tid`,
    { id: contratoId, tid: tenantId }
  );
  if (!r.rows.length) throw new ErroOperador(404, 'Contrato não encontrado.');
  return r.rows[0];
}

/** Histórico de contratos do tenant, mais recente primeiro. */
async function listarContratos(tenantId) {
  return comOperador(async (conn) => {
    await carregarTenant(conn, tenantId);
    const r = await conn.execute(
      `SELECT * FROM contrato WHERE tenant_id = :tid ORDER BY criado_em DESC, id DESC`,
      { tid: tenantId }
    );
    return r.rows.map(linhaContrato);
  });
}

/**
 * Cria um contrato novo para o tenant. Se já existe um ATIVO, encerra-o
 * (fim_vigencia = hoje) na MESMA transação antes de inserir o novo — é o que
 * "trocar de plano" significa neste domínio (nunca sobrescreve).
 */
async function criarOuTrocarContrato({ operador, tenantId, dados, ip }) {
  const v = validarNovoContrato(dados);
  return comOperador(async (conn) => {
    await carregarTenant(conn, tenantId);
    const anterior = await carregarContratoAtivo(conn, tenantId);
    if (anterior) {
      // GREATEST(CURRENT_DATE, inicio_cobranca) — não CURRENT_DATE puro.
      // Achado de review (FIL-76): quando o contrato ativo ainda não começou
      // a cobrar (inicio_cobranca no futuro — período de implantação), hoje é
      // ANTERIOR ao início de cobrança, e fim_vigencia = CURRENT_DATE violaria
      // ck_contrato_vigencia (fim_vigencia >= inicio_cobranca), derrubando a
      // troca de plano com rollback. Encerrar exatamente no início de
      // cobrança (janela de 0 dias) reflete a realidade: nunca chegou a
      // cobrar nada desse contrato — sem inventar um "cancelado" separado.
      await conn.execute(
        `UPDATE contrato SET fim_vigencia = GREATEST(CURRENT_DATE, inicio_cobranca) WHERE id = :id`,
        { id: anterior.ID }
      );
    }
    const ins = await conn.execute(
      `INSERT INTO contrato
         (tenant_id, plano_nome, valor_recorrente_centavos, ciclo, dia_vencimento,
          inicio_cobranca, reajuste_indice, reajuste_mes, observacoes, criado_por)
       VALUES
         (:tenantId, :planoNome, :valorRecorrenteCentavos, :ciclo, :diaVencimento,
          :inicioCobranca, :reajusteIndice, :reajusteMes, :observacoes, :criadoPor)
       RETURNING *`,
      {
        tenantId, planoNome: v.planoNome, valorRecorrenteCentavos: v.valorRecorrenteCentavos,
        ciclo: v.ciclo, diaVencimento: v.diaVencimento, inicioCobranca: v.inicioCobranca,
        reajusteIndice: v.reajusteIndice, reajusteMes: v.reajusteMes, observacoes: v.observacoes,
        criadoPor: operador.id,
      }
    );
    const novo = ins.rows[0];

    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'contrato_criado', entidade: 'contrato', entidadeId: Number(novo.ID),
      detalhe: {
        antes: anterior ? {
          contratoId: Number(anterior.ID), planoNome: anterior.PLANO_NOME,
          valorRecorrenteCentavos: Number(anterior.VALOR_RECORRENTE_CENTAVOS), ciclo: anterior.CICLO,
        } : null,
        depois: {
          contratoId: Number(novo.ID), planoNome: v.planoNome,
          valorRecorrenteCentavos: v.valorRecorrenteCentavos, ciclo: v.ciclo,
        },
      },
      ip,
    });
    return linhaContrato(novo);
  });
}

/** Itens de um contrato (qualquer um — ativo ou histórico). */
async function listarItens({ tenantId, contratoId }) {
  return comOperador(async (conn) => {
    await carregarContrato(conn, tenantId, contratoId);
    const r = await conn.execute(
      `SELECT * FROM contrato_item WHERE contrato_id = :cid ORDER BY criado_em`,
      { cid: contratoId }
    );
    return mapRows(r.rows);
  });
}

function exigirContratoAtivo(contrato) {
  if (contrato.FIM_VIGENCIA !== null && contrato.FIM_VIGENCIA !== undefined) {
    throw new ErroOperador(409, 'Contrato encerrado — itens só podem ser alterados no contrato ativo.');
  }
}

async function adicionarItem({ operador, tenantId, contratoId, dados, ip }) {
  const v = validarItem(dados);
  return comOperador(async (conn) => {
    const contrato = await carregarContrato(conn, tenantId, contratoId);
    exigirContratoAtivo(contrato);
    const ins = await conn.execute(
      `INSERT INTO contrato_item (contrato_id, tipo, descricao, valor_unitario_centavos, quantidade, recorrente)
       VALUES (:cid, :tipo, :desc, :valor, :qtd, :rec)
       RETURNING *`,
      { cid: contratoId, tipo: v.tipo, desc: v.descricao, valor: v.valorUnitarioCentavos, qtd: v.quantidade, rec: v.recorrente }
    );
    const item = ins.rows[0];
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'contrato_item_adicionado', entidade: 'contrato_item', entidadeId: Number(item.ID),
      detalhe: { contratoId, antes: null, depois: v },
      ip,
    });
    return mapRow(item);
  });
}

async function carregarItem(conn, contratoId, itemId) {
  const r = await conn.execute(
    `SELECT * FROM contrato_item WHERE id = :id AND contrato_id = :cid`,
    { id: itemId, cid: contratoId }
  );
  if (!r.rows.length) throw new ErroOperador(404, 'Item não encontrado.');
  return r.rows[0];
}

async function atualizarItem({ operador, tenantId, contratoId, itemId, dados, ip }) {
  const v = validarItem(dados);
  return comOperador(async (conn) => {
    const contrato = await carregarContrato(conn, tenantId, contratoId);
    exigirContratoAtivo(contrato);
    const antes = await carregarItem(conn, contratoId, itemId);
    const upd = await conn.execute(
      `UPDATE contrato_item
          SET tipo = :tipo, descricao = :desc, valor_unitario_centavos = :valor,
              quantidade = :qtd, recorrente = :rec, atualizado_em = now()
        WHERE id = :id AND contrato_id = :cid
        RETURNING *`,
      { tipo: v.tipo, desc: v.descricao, valor: v.valorUnitarioCentavos, qtd: v.quantidade, rec: v.recorrente, id: itemId, cid: contratoId }
    );
    const depois = upd.rows[0];
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'contrato_item_atualizado', entidade: 'contrato_item', entidadeId: Number(itemId),
      detalhe: {
        contratoId,
        antes: {
          tipo: antes.TIPO, descricao: antes.DESCRICAO,
          valorUnitarioCentavos: Number(antes.VALOR_UNITARIO_CENTAVOS),
          quantidade: Number(antes.QUANTIDADE), recorrente: antes.RECORRENTE,
        },
        depois: v,
      },
      ip,
    });
    return mapRow(depois);
  });
}

async function removerItem({ operador, tenantId, contratoId, itemId, ip }) {
  return comOperador(async (conn) => {
    const contrato = await carregarContrato(conn, tenantId, contratoId);
    exigirContratoAtivo(contrato);
    const antes = await carregarItem(conn, contratoId, itemId);
    await conn.execute(`DELETE FROM contrato_item WHERE id = :id AND contrato_id = :cid`, { id: itemId, cid: contratoId });
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'contrato_item_removido', entidade: 'contrato_item', entidadeId: Number(itemId),
      detalhe: {
        contratoId,
        antes: {
          tipo: antes.TIPO, descricao: antes.DESCRICAO,
          valorUnitarioCentavos: Number(antes.VALOR_UNITARIO_CENTAVOS),
          quantidade: Number(antes.QUANTIDADE), recorrente: antes.RECORRENTE,
        },
        depois: null,
      },
      ip,
    });
    return { ok: true };
  });
}

module.exports = {
  CICLOS, TIPOS_ITEM,
  listarContratos, criarOuTrocarContrato,
  listarItens, adicionarItem, atualizarItem, removerItem,
  validarNovoContrato, validarItem,
};
