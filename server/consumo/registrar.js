// consumo/registrar.js — grava o consumo cobrável POR TENANT (FIL-77):
// tokens de IA, mensagem enviada, mídia armazenada. Chamado de dentro de
// db.comTenant() (ia/runtime.js, api/conversas.js) — a conexão já está no
// contexto do tenant certo (RLS isolamento_tenant, migração 016).
//
// ⚠️ REGRA DE OURO (docs/SEGURANCA.md / ticket): medir NUNCA pode derrubar
// nem atrasar o atendimento. Toda função aqui é best-effort — captura
// qualquer erro, loga e retorna normalmente. Quem chama não precisa (e não
// deve) envolver estas chamadas em try/catch de novo.
//
// ⚠️ SEM CONEXÃO ANINHADA (mesmo achado de review do FIL-78, ver o cabeçalho
// de ia/iaConfigStore.js): este módulo NUNCA abre uma transação de operador
// (consumo/precos.js::carregarPreco) por baixo dos panos enquanto a conexão
// de tenant do chamador (`conn`, passada por parâmetro) está aberta — isso
// prenderia 2 conexões do pool ao mesmo tempo pela mesma requisição.
// `registrarIaTokens` por isso recebe o PREÇO JÁ RESOLVIDO (`preco`) — quem
// chama resolve consumo/precos.js::carregarPreco() numa fase própria, fora
// de qualquer db.comTenant() em andamento (ver ia/runtime.js e
// api/conversas.js::/sugestao-resposta). db.comSavepoint() abaixo NÃO abre
// conexão nova — roda SAVEPOINT/ROLLBACK TO SAVEPOINT na MESMA `conn`.
'use strict';

const db = require('../db/pool');
const limitePlano = require('../ia/limitePlano');

const TIPOS = Object.freeze(['ia_tokens', 'mensagem_enviada', 'conversa_iniciada', 'midia_armazenada']);

/**
 * Grava 1 evento de consumo. NUNCA lança.
 *
 * ⚠️ Achado de review (P1): sem SAVEPOINT, um INSERT que falha (constraint,
 * RLS, tabela ausente) marca a transação Postgres INTEIRA como abortada —
 * capturar a exceção em JS não desfaz isso. Sem isolamento, a mensagem já
 * enviada pelo WhatsApp (e o resto do trabalho da mesma transação) sofreria
 * ROLLBACK silencioso no COMMIT final: cliente recebe, sistema esquece. Por
 * isso todo INSERT deste módulo roda dentro de db.comSavepoint() — só o
 * evento de consumo é descartado, a transação do chamador segue saudável.
 */
async function registrar(conn, tenantId, { tipo, quantidade, custoCentavos = null, referencia = null }) {
  if (!TIPOS.includes(tipo)) {
    console.error(`[consumo] tipo de evento inválido, evento descartado: ${tipo}`);
    return;
  }
  const qtd = Math.max(0, Math.round(Number(quantidade) || 0));
  try {
    await db.comSavepoint(conn, () => conn.execute(
      `INSERT INTO consumo_evento (tenant_id, tipo, quantidade, custo_centavos, referencia, criado_em)
       VALUES (:tenantId, :tipo, :qtd, :custo, :ref, now())`,
      { tenantId, tipo, qtd, custo: custoCentavos, ref: referencia }
    ));
  } catch (err) {
    console.error('[consumo] falha ao gravar evento (não afeta o atendimento):', err.message);
  }
}

/** Custo em centavos a partir do preço já resolvido (consumo/precos.js) —
 *  cálculo puro, sem banco. `null` se `preco` for null (provider+modelo
 *  ainda sem preço cadastrado) — nunca inventa um valor. */
function calcularCustoCentavos(preco, tokensEntrada, tokensSaida) {
  if (!preco) return null;
  return (tokensEntrada / 1000) * preco.precoEntradaCentavos1k + (tokensSaida / 1000) * preco.precoSaidaCentavos1k;
}

/**
 * Tokens de UMA chamada ao provedor de IA: grava o evento `ia_tokens` com o
 * custo (a partir do `preco` JÁ RESOLVIDO por quem chama — ver o cabeçalho
 * deste arquivo sobre por que este módulo não busca o preço sozinho; `null`
 * quando o preço daquele provider+modelo ainda não foi cadastrado, nunca
 * estimado por caractere) e incrementa `ia_consumo_mensal` — o teto do
 * FIL-78 (ia/limitePlano.js) é o ponto de extensão que aquela migração
 * deixou pronto para o FIL-77 plugar. NUNCA lança.
 */
async function registrarIaTokens(conn, tenantId, { tokensEntrada = 0, tokensSaida = 0, preco = null, referencia = null }) {
  const entrada = Number(tokensEntrada) || 0;
  const saida = Number(tokensSaida) || 0;
  const total = entrada + saida;
  if (total <= 0) return; // provedor não devolveu uso nesta chamada — nada a medir

  const custoCentavos = calcularCustoCentavos(preco, entrada, saida);
  await registrar(conn, tenantId, { tipo: 'ia_tokens', quantidade: total, custoCentavos, referencia });

  try {
    await db.comSavepoint(conn, () => conn.execute(
      `INSERT INTO ia_consumo_mensal (tenant_id, ano_mes, tokens_usados, atualizado_em)
       VALUES (:tenantId, :anoMes, :tokens, now())
       ON CONFLICT (tenant_id, ano_mes) DO UPDATE SET
         tokens_usados = ia_consumo_mensal.tokens_usados + EXCLUDED.tokens_usados, atualizado_em = now()`,
      { tenantId, anoMes: limitePlano.anoMesAtual(), tokens: total }
    ));
  } catch (err) {
    console.error('[consumo] falha ao atualizar teto mensal de IA (não afeta o atendimento):', err.message);
  }
}

module.exports = { TIPOS, registrar, registrarIaTokens };
