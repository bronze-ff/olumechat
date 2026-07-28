// consumo/registrar.js — grava o consumo cobrável POR TENANT (FIL-77):
// tokens de IA, mensagem enviada, mídia armazenada. Chamado de dentro de
// db.comTenant() (ia/runtime.js, api/conversas.js) — a conexão já está no
// contexto do tenant certo (RLS isolamento_tenant, migração 016).
//
// ⚠️ REGRA DE OURO (docs/SEGURANCA.md / ticket): medir NUNCA pode derrubar
// nem atrasar o atendimento. Toda função aqui é best-effort — captura
// qualquer erro, loga e retorna normalmente. Quem chama não precisa (e não
// deve) envolver estas chamadas em try/catch de novo.
'use strict';

const precos = require('./precos');
const limitePlano = require('../ia/limitePlano');

const TIPOS = Object.freeze(['ia_tokens', 'mensagem_enviada', 'conversa_iniciada', 'midia_armazenada']);

/** Grava 1 evento de consumo. NUNCA lança. */
async function registrar(conn, tenantId, { tipo, quantidade, custoCentavos = null, referencia = null }) {
  if (!TIPOS.includes(tipo)) {
    console.error(`[consumo] tipo de evento inválido, evento descartado: ${tipo}`);
    return;
  }
  const qtd = Math.max(0, Math.round(Number(quantidade) || 0));
  try {
    await conn.execute(
      `INSERT INTO consumo_evento (tenant_id, tipo, quantidade, custo_centavos, referencia, criado_em)
       VALUES (:tenantId, :tipo, :qtd, :custo, :ref, now())`,
      { tenantId, tipo, qtd, custo: custoCentavos, ref: referencia }
    );
  } catch (err) {
    console.error('[consumo] falha ao gravar evento (não afeta o atendimento):', err.message);
  }
}

/**
 * Tokens de UMA chamada ao provedor de IA: grava o evento `ia_tokens` com o
 * custo calculado pela tabela de preço do operador (consumo/precos.js;
 * `null` se o preço daquele provider+modelo ainda não foi cadastrado — nunca
 * estimamos por caractere, só usamos o uso real que o provedor devolveu) e
 * incrementa `ia_consumo_mensal` — o teto do FIL-78 (ia/limitePlano.js) é o
 * ponto de extensão que aquela migração deixou pronto para o FIL-77 plugar.
 * NUNCA lança.
 */
async function registrarIaTokens(conn, tenantId, { tokensEntrada = 0, tokensSaida = 0, provider, modelo, referencia = null }) {
  const entrada = Number(tokensEntrada) || 0;
  const saida = Number(tokensSaida) || 0;
  const total = entrada + saida;
  if (total <= 0) return; // provedor não devolveu uso nesta chamada — nada a medir

  let custoCentavos = null;
  try {
    const preco = await precos.carregarPreco(provider, modelo);
    if (preco) {
      custoCentavos = (entrada / 1000) * preco.precoEntradaCentavos1k + (saida / 1000) * preco.precoSaidaCentavos1k;
    }
  } catch (err) {
    console.error('[consumo] falha ao calcular custo (evento gravado sem custo):', err.message);
  }

  await registrar(conn, tenantId, { tipo: 'ia_tokens', quantidade: total, custoCentavos, referencia });

  try {
    await conn.execute(
      `INSERT INTO ia_consumo_mensal (tenant_id, ano_mes, tokens_usados, atualizado_em)
       VALUES (:tenantId, :anoMes, :tokens, now())
       ON CONFLICT (tenant_id, ano_mes) DO UPDATE SET
         tokens_usados = ia_consumo_mensal.tokens_usados + EXCLUDED.tokens_usados, atualizado_em = now()`,
      { tenantId, anoMes: limitePlano.anoMesAtual(), tokens: total }
    );
  } catch (err) {
    console.error('[consumo] falha ao atualizar teto mensal de IA (não afeta o atendimento):', err.message);
  }
}

module.exports = { TIPOS, registrar, registrarIaTokens };
