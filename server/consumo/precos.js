// consumo/precos.js — tabela de PREÇO por provider/modelo, mantida pelo
// OPERADOR (FIL-77). O provedor de IA devolve tokens consumidos; o preço em
// reais é nosso — por isso fica numa tabela editável (`preco_provedor`,
// migração 016), nunca hardcoded no runtime (ia/runtime.js,
// ia/sugestaoResposta.js só consomem carregarPreco()).
//
// MESMO PADRÃO DE ISOLAMENTO de operador/credencialIa.js: `preco_provedor` é
// FECHADA para o caminho de tenant (RLS deny + REVOKE, ver a migração 016) —
// só comOperador() (BYPASSRLS) toca esta tabela.
//
// Cache com TTL 60s (mesmo padrão de ia/iaConfigStore.js): consumo/registrar.js
// chama carregarPreco() a cada chamada de IA — sem cache, isso seria uma
// consulta extra ao banco por mensagem do bot.
'use strict';

const { comOperador } = require('../operador/db');
const auditoria = require('../operador/auditoria');
const { ErroOperador } = require('../operador/erroOperador');
const { IA_PROVEDORES } = require('../operador/validacaoIa');

const TTL_MS = 60_000;
const cache = new Map(); // `${provider}::${modelo}` -> { valor, exp }

function chaveCache(provider, modelo) {
  return `${provider}::${modelo}`;
}

function validarPreco({ provider, modelo, precoEntradaCentavos1k, precoSaidaCentavos1k }) {
  if (!IA_PROVEDORES.includes(provider)) throw new ErroOperador(400, 'Provedor inválido.');
  const modeloTrim = String(modelo || '').trim();
  if (!modeloTrim) throw new ErroOperador(400, 'Modelo obrigatório.');
  const entrada = Number(precoEntradaCentavos1k);
  const saida = Number(precoSaidaCentavos1k);
  if (!Number.isFinite(entrada) || entrada < 0) throw new ErroOperador(400, 'Preço de entrada inválido (centavos por 1000 tokens, >= 0).');
  if (!Number.isFinite(saida) || saida < 0) throw new ErroOperador(400, 'Preço de saída inválido (centavos por 1000 tokens, >= 0).');
  return { provider, modelo: modeloTrim, precoEntradaCentavos1k: entrada, precoSaidaCentavos1k: saida };
}

/** Todos os preços cadastrados (histórico por provider+modelo). */
async function listarPrecos() {
  return comOperador(async (conn) => {
    let r;
    try {
      r = await conn.execute(
        `SELECT provider, modelo, preco_entrada_centavos_1k, preco_saida_centavos_1k, atualizado_em
           FROM preco_provedor ORDER BY provider, modelo`);
    } catch (err) {
      if (err.code === '42P01') return []; // migração 016 ainda não aplicada
      throw err;
    }
    return r.rows.map((row) => ({
      provider: row.PROVIDER,
      modelo: row.MODELO,
      precoEntradaCentavos1k: Number(row.PRECO_ENTRADA_CENTAVOS_1K),
      precoSaidaCentavos1k: Number(row.PRECO_SAIDA_CENTAVOS_1K),
      atualizadoEm: row.ATUALIZADO_EM,
    }));
  });
}

/** Grava/atualiza o preço de um provider+modelo (upsert) e audita. */
async function salvarPreco({ operador, provider, modelo, precoEntradaCentavos1k, precoSaidaCentavos1k, ip }) {
  const v = validarPreco({ provider, modelo, precoEntradaCentavos1k, precoSaidaCentavos1k });
  return comOperador(async (conn) => {
    await conn.execute(
      `INSERT INTO preco_provedor (provider, modelo, preco_entrada_centavos_1k, preco_saida_centavos_1k, atualizado_em)
       VALUES (:p, :m, :pe, :ps, now())
       ON CONFLICT (provider, modelo) DO UPDATE SET
         preco_entrada_centavos_1k = EXCLUDED.preco_entrada_centavos_1k,
         preco_saida_centavos_1k = EXCLUDED.preco_saida_centavos_1k,
         atualizado_em = now()`,
      { p: v.provider, m: v.modelo, pe: v.precoEntradaCentavos1k, ps: v.precoSaidaCentavos1k });
    await auditoria.registrar(conn, {
      operador, tenantId: null, acao: 'preco_provedor_alterado',
      entidade: 'preco_provedor', entidadeId: null,
      detalhe: { provider: v.provider, modelo: v.modelo, precoEntradaCentavos1k: v.precoEntradaCentavos1k, precoSaidaCentavos1k: v.precoSaidaCentavos1k },
      ip,
    });
    cache.delete(chaveCache(v.provider, v.modelo));
    return v;
  });
}

/** Preço de UM provider+modelo (com cache), ou null se não cadastrado — quem
 *  chama trata "sem preço" como custo desconhecido, nunca inventa um valor. */
async function carregarPreco(provider, modelo) {
  const chave = chaveCache(provider, modelo);
  const hit = cache.get(chave);
  if (hit && hit.exp > Date.now()) return hit.valor;

  let valor = null;
  try {
    valor = await comOperador(async (conn) => {
      let r;
      try {
        r = await conn.execute(
          `SELECT preco_entrada_centavos_1k, preco_saida_centavos_1k FROM preco_provedor
            WHERE provider = :p AND modelo = :m`,
          { p: provider, m: modelo });
      } catch (err) {
        if (err.code === '42P01') return null;
        throw err;
      }
      if (!r.rows.length) return null;
      return {
        precoEntradaCentavos1k: Number(r.rows[0].PRECO_ENTRADA_CENTAVOS_1K),
        precoSaidaCentavos1k: Number(r.rows[0].PRECO_SAIDA_CENTAVOS_1K),
      };
    });
  } catch (err) {
    console.error('[consumo] falha ao carregar preço do provedor:', err.message);
  }
  cache.set(chave, { valor, exp: Date.now() + TTL_MS });
  return valor;
}

function invalidarCache() { cache.clear(); }

module.exports = { listarPrecos, salvarPreco, carregarPreco, invalidarCache };
