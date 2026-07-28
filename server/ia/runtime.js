// server/ia/runtime.js — orquestra a conversa do bot de IA. Assinatura espelha
// bot/runtime.processarEntrada: fire-and-forget, abre a própria conexão.
//
// FIL-63: processarEntrada(tenantId, conversaId, texto) abre o contexto de
// tenant via db.comTenant() (RLS + SET LOCAL ROLE) e roda toda a operação —
// leitura da conversa, autorização, config de IA, histórico e envio — dentro
// dessa mesma transação. O chamador atual (webhook/processEvent.js, fora do
// escopo deste ticket) ainda repassa só (conversaId, texto): o porte do
// webhook resolve o tenant a partir do phone_number_id (único GLOBAL — ver
// docs/PORTE.md) e vai atualizar essa chamada para passar o tenantId também.
'use strict';
const db = require('../db/pool');
const { sendText } = require('../graph/sendText');
const store = require('./iaConfigStore');
const perfilStore = require('./perfilStore');
const client = require('./client');
const toolExec = require('./toolExecutor');
const auth = require('./autorizacao');
const historico = require('./historico');
const limitePlano = require('./limitePlano');
const consumo = require('../consumo/registrar');
const precos = require('../consumo/precos');
const { partirTexto } = require('./chunk');

const MAX_ITER = 4;
const MSG_TETO_ESTOURADO = 'O assistente atingiu o limite de uso deste mês. Peça para o administrador da sua empresa entrar em contato com o suporte.';
// FIL-83: mensagem de canal restrito. NÃO pode citar empresa nenhuma — ela
// chega ao cliente final de QUALQUER empresa da plataforma (o texto anterior
// mandava falar com "a TI" da empresa do fork original).
const MSG_NAO_AUTORIZADO = 'Olá! Este canal é restrito e o seu número ainda não está liberado para falar com o assistente. '
  + 'Se precisar de atendimento, procure a empresa pelos canais habituais.';

async function carregarConversa(conn, tenantId, conversaId) {
  const r = await conn.execute(
    `SELECT c.ID, c.CONTATO_ID, c.NUMERO_ID, c.FILA_STATUS, ct.TELEFONE,
            n.PHONE_NUMBER_ID, n.IA_MODO_TESTE
       FROM conversa c
       JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.ID = c.CONTATO_ID
       LEFT JOIN numero n ON n.tenant_id = c.tenant_id AND n.ID = c.NUMERO_ID
      WHERE c.tenant_id = :tenantId AND c.ID = :id`, { tenantId, id: conversaId });
  if (!r.rows || !r.rows.length) return null;
  const row = r.rows[0];
  return {
    conversaId, contatoId: row.CONTATO_ID, numeroId: row.NUMERO_ID,
    telefone: row.TELEFONE, phoneNumberId: row.PHONE_NUMBER_ID,
    filaStatus: row.FILA_STATUS || null,
    // FIL-84: 'S' = allowlist (modo teste); 'N' = canal aberto a qualquer
    // cliente. Coluna ausente (migração 021 pendente) ⇒ 'S', o fail-closed que
    // o canal tinha antes.
    iaModoTeste: row.IA_MODO_TESTE || 'S',
  };
}

async function responder(conn, tenantId, cv, textos) {
  for (const bruto of textos) {
    for (const pedaco of partirTexto(bruto, 4096)) {
      let wamid = null, status = 'sent';
      try { const resp = await sendText(cv.telefone, pedaco, cv.phoneNumberId); wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id; }
      catch (e) { status = 'falha'; console.error('[ia] falha ao enviar:', e.message); }
      await conn.execute(
        `INSERT INTO mensagem (tenant_id, CONVERSA_ID, CONTATO_ID, NUMERO_ID, WAMID, DIRECAO, TIPO, CONTEUDO, ORIGEM, STATUS, TS)
         VALUES (:tenantId, :cv, :ct, :num, :wamid, 'out', 'text', :txt, 'ia', :st, now())`,
        { tenantId, cv: cv.conversaId, ct: cv.contatoId, num: cv.numeroId, wamid, txt: pedaco, st: status });
      // Medição de consumo (FIL-76/FIL-77): achado de review — resposta do
      // bot de IA não tinha produtor de mensagem_enviada nenhum (só ia_tokens
      // já existia; medir todo caminho de envio, não só as rotas manuais de
      // conversas.js). Só o que REALMENTE saiu é cobrável.
      if (status === 'sent') {
        await consumo.registrar(conn, tenantId, { tipo: 'mensagem_enviada', quantidade: 1, referencia: cv.conversaId });
      }
    }
  }
}

/**
 * FIL-78 (achado de review): resolver a credencial (store.carregar) exige
 * NÃO segurar a conexão de tenant ao mesmo tempo — na falta de chave própria
 * ela abre sua própria transação de operador (ver ia/iaConfigStore.js), e
 * duas conexões seguradas por uma mesma requisição esgotam o pool sob
 * concorrência. Por isso o processamento roda em 3 fases sequenciais, nunca
 * duas conexões abertas ao mesmo tempo:
 *   1) comTenant — valida conversa, plano (ia_habilitada + teto) e
 *      autorização; já pode terminar aqui (e manda um recado) sem nunca
 *      precisar da credencial.
 *   2) SEM conexão nenhuma aberta — resolve a credencial.
 *   3) comTenant (nova transação) — histórico, loop de tool-calls, resposta.
 */
async function processarEntrada(tenantId, conversaId, texto) {
  try {
    const cv = await db.comTenant(tenantId, async (conn) => {
      const cv = await carregarConversa(conn, tenantId, conversaId);
      if (!cv) return null;

      // A conversa pode ter saído da IA entre o webhook e este ponto (o
      // atendente clicou em Assumir). Não é erro: a IA simplesmente cala.
      if (cv.filaStatus !== 'ia') return null;

      // IA é add-on vendido à parte (FIL-70-ia): plano desligado ⇒ o bot nem
      // tenta responder, mesmo que ia_config ainda tenha um provedor salvo de
      // uma configuração anterior do operador. Checagem server-side, não só
      // de UI — quem liga/desliga é operador/tenants.js::definirIa.
      const tenantRow = await conn.execute(`SELECT ia_habilitada FROM tenant WHERE id = :tenantId`, { tenantId });
      if ((tenantRow.rows[0] || {}).IA_HABILITADA !== 'S') return null;

      // Teto mensal do add-on (FIL-78): estourar bloqueia ANTES de gastar 1
      // token no provedor. Mensagem genérica — nunca fala de custo/tokens
      // (ver ia/limitePlano.js).
      if (await limitePlano.estourouTeto(conn, tenantId)) {
        await responder(conn, tenantId, cv, [MSG_TETO_ESTOURADO]);
        return null;
      }

      // FIL-84: a allowlist virou o MODO TESTE do canal. Ligado ⇒ só telefone
      // autorizado é respondido (comportamento de piloto, e o default da
      // migração 021 para quem já estava em modo='ia'). Desligado ⇒ a IA atende
      // qualquer cliente do canal, e a mensagem de "canal restrito" nem existe.
      if (cv.iaModoTeste === 'S'
          && !(await auth.autorizado(conn, tenantId, cv.telefone, cv.numeroId))) {
        await responder(conn, tenantId, cv, [MSG_NAO_AUTORIZADO]);
        return null;
      }
      return cv;
    });
    if (!cv) return;

    // Fase 2 — nenhuma conexão do pool aberta aqui.
    const config = await store.carregar(tenantId);
    // Preço (FIL-77) resolvido AQUI, na mesma fase — consumo/precos.js abre
    // sua própria transação de operador; resolver dentro da comTenant() da
    // fase 3 prenderia 2 conexões do pool ao mesmo tempo pela mesma
    // requisição (o mesmo defeito de conexão aninhada que esta função já
    // corrige para a credencial, ver o comentário acima).
    const preco = config ? await precos.carregarPreco(config.provider, config.modelo) : null;

    // Fase 3 — nova transação de tenant, só para o que falta.
    await db.comTenant(tenantId, async (conn) => {
      if (!config) {
        await responder(conn, tenantId, cv, ['O assistente está temporariamente indisponível (provedor de IA não configurado).']);
        return;
      }

      await historico.salvar(conn, tenantId, conversaId, 'user', { texto });
      let mensagens = await historico.carregar(conn, tenantId, conversaId);

      let respostaFinal = '';
      // FIL-83: o system prompt vem do BANCO, por empresa (instruções + ficha +
      // blocos ativos), montado em camadas com a base anti-alucinação por cima
      // — ver ia/perfilStore.js. Antes era uma leitura de arquivo a cada
      // mensagem, global ao processo e ausente do repositório. Roda com o
      // `conn` DESTA fase de propósito: o conteúdo é 100% do tenant e não pode
      // custar uma segunda conexão do pool (ver o comentário das 3 fases acima).
      const sistema = perfilStore.montarSistema(await perfilStore.carregar(conn, tenantId));
      // A chamada ao provedor (client.chamar) é o ponto mais provável de falhar
      // (chave, cota, modelo inexistente, rede, timeout). Um throw aqui NÃO pode
      // virar silêncio: capturamos, logamos com detalhe e caímos no fallback
      // amigável abaixo — que é SEMPRE enviado. (Erros de tool já são tratados no
      // try interno e voltam como resultado para o modelo.)
      let tetoEstourouNoMeio = false;
      try {
        for (let i = 0; i < MAX_ITER; i++) {
          // Rechecagem do teto (achado de review, P2): a 1ª iteração já foi
          // gated na fase 1, mas se ELA MESMA (registrarIaTokens acima acaba
          // de incrementar ia_consumo_mensal) estourar o teto, as iterações
          // seguintes do loop de tool-calls não podem seguir gastando token
          // pago do provedor — sem isto, até MAX_ITER-1 chamadas extras
          // passavam do limite.
          if (i > 0 && await limitePlano.estourouTeto(conn, tenantId)) {
            tetoEstourouNoMeio = true;
            break;
          }
          const out = await client.chamar({ config, sistema, mensagens });
          // Mede a CADA chamada ao provedor (FIL-77): tokens reais que ele
          // devolveu, nunca estimados. Best-effort — nunca derruba o turno.
          // `preco` já foi resolvido na fase 2 (fora desta conexão) — não faz
          // mais nenhuma consulta de preço por baixo dos panos aqui dentro.
          await consumo.registrarIaTokens(conn, tenantId, {
            tokensEntrada: out.uso && out.uso.tokensEntrada,
            tokensSaida: out.uso && out.uso.tokensSaida,
            preco, referencia: conversaId,
          });
          if (out.toolCalls && out.toolCalls.length) {
            for (const tc of out.toolCalls) {
              await historico.salvar(conn, tenantId, conversaId, 'assistant', { texto: out.texto, toolCallId: tc.id, nome: tc.nome, args: tc.args });
              let resultado;
              try { const r = await toolExec.executar(conn, tc.nome, tc.args); resultado = JSON.stringify(r.linhas); }
              catch (e) { resultado = JSON.stringify({ erro: e.message }); }
              await historico.salvar(conn, tenantId, conversaId, 'tool', { toolCallId: tc.id, nome: tc.nome, resultado });
            }
            mensagens = await historico.carregar(conn, tenantId, conversaId);
            continue;
          }
          respostaFinal = (out.texto || '').trim();
          // Só persiste turno assistant COM conteúdo: turno vazio remonta como
          // content:[] e o provedor rejeita (400) na próxima msg — envenena a conversa.
          if (respostaFinal) await historico.salvar(conn, tenantId, conversaId, 'assistant', { texto: respostaFinal });
          break;
        }
      } catch (err) {
        console.error('[ia] provedor falhou:', (err && err.message) || err);
        respostaFinal = '';
      }
      if (!respostaFinal) {
        // Mesma mensagem genérica da fase 1 (nunca fala de custo/tokens) —
        // consistente para o cliente, não importa em qual ponto o teto bateu.
        respostaFinal = tetoEstourouNoMeio
          ? MSG_TETO_ESTOURADO
          : 'Não consegui responder agora — o assistente está indisponível no momento. Tente de novo em instantes.';
      }
      await responder(conn, tenantId, cv, [respostaFinal]);
    });
  } catch (err) {
    console.error('[ia] runtime falhou:', err.message);
  }
}

module.exports = { processarEntrada };
