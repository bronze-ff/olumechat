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
const client = require('./client');
const toolExec = require('./toolExecutor');
const auth = require('./autorizacao');
const historico = require('./historico');
const limitePlano = require('./limitePlano');
const { partirTexto } = require('./chunk');

const SISTEMA_FALLBACK = 'Você é o assistente da Multicanal Atacado no WhatsApp. Responda de forma objetiva '
  + 'e em português. Use SOMENTE as ferramentas disponíveis para obter números; nunca invente dados. '
  + 'Formate valores em R$ e datas em DD/MM/AAAA.';
const MAX_ITER = 4;

/** System prompt curado vem do mc-OS (sync) em CONHECIMENTO_DIR/system-prompt.md;
    o fallback embutido só cobre instalação sem o arquivo. */
function carregarSistema() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { loadConfig } = require('../config');
    const p = path.join(loadConfig({ requireDb: false }).conhecimentoDir, 'system-prompt.md');
    const txt = fs.readFileSync(p, 'utf8').trim();
    return txt || SISTEMA_FALLBACK;
  } catch { return SISTEMA_FALLBACK; }
}

async function carregarConversa(conn, tenantId, conversaId) {
  const r = await conn.execute(
    `SELECT c.ID, c.CONTATO_ID, c.NUMERO_ID, ct.TELEFONE, n.PHONE_NUMBER_ID
       FROM conversa c
       JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.ID = c.CONTATO_ID
       LEFT JOIN numero n ON n.tenant_id = c.tenant_id AND n.ID = c.NUMERO_ID
      WHERE c.tenant_id = :tenantId AND c.ID = :id`, { tenantId, id: conversaId });
  if (!r.rows || !r.rows.length) return null;
  const row = r.rows[0];
  return { conversaId, contatoId: row.CONTATO_ID, numeroId: row.NUMERO_ID, telefone: row.TELEFONE, phoneNumberId: row.PHONE_NUMBER_ID };
}

async function responder(conn, tenantId, cv, textos) {
  for (const bruto of textos) {
    for (const pedaco of partirTexto(bruto, 4096)) {
      let wamid = null, status = 'sent';
      try { const resp = await sendText(cv.telefone, pedaco, cv.phoneNumberId); wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id; }
      catch (e) { status = 'falha'; console.error('[ia] falha ao enviar:', e.message); }
      await conn.execute(
        `INSERT INTO mensagem (tenant_id, CONVERSA_ID, CONTATO_ID, NUMERO_ID, WAMID, DIRECAO, TIPO, CONTEUDO, STATUS, TS)
         VALUES (:tenantId, :cv, :ct, :num, :wamid, 'out', 'text', :txt, :st, now())`,
        { tenantId, cv: cv.conversaId, ct: cv.contatoId, num: cv.numeroId, wamid, txt: pedaco, st: status });
    }
  }
}

async function processarEntrada(tenantId, conversaId, texto) {
  try {
    await db.comTenant(tenantId, async (conn) => {
      const cv = await carregarConversa(conn, tenantId, conversaId);
      if (!cv) return;

      // IA é add-on vendido à parte (FIL-70-ia): plano desligado ⇒ o bot nem
      // tenta responder, mesmo que ia_config ainda tenha um provedor salvo de
      // uma configuração anterior do operador. Checagem server-side, não só
      // de UI — quem liga/desliga é operador/tenants.js::definirIa.
      const tenantRow = await conn.execute(`SELECT ia_habilitada FROM tenant WHERE id = :tenantId`, { tenantId });
      if ((tenantRow.rows[0] || {}).IA_HABILITADA !== 'S') return;

      // Teto mensal do add-on (FIL-78): estourar bloqueia ANTES de gastar 1
      // token no provedor. Mensagem genérica — nunca fala de custo/tokens
      // (ver ia/limitePlano.js).
      if (await limitePlano.estourouTeto(conn, tenantId)) {
        await responder(conn, tenantId, cv, ['O assistente atingiu o limite de uso deste mês. Peça para o administrador da sua empresa entrar em contato com o suporte.']);
        return;
      }

      if (!(await auth.autorizado(conn, tenantId, cv.telefone, cv.numeroId))) {
        await responder(conn, tenantId, cv, ['Olá! Este canal é restrito. Fale com a TI da Multicanal para liberar seu acesso.']);
        return;
      }
      const config = await store.carregar(conn, tenantId);
      if (!config) {
        await responder(conn, tenantId, cv, ['O assistente está temporariamente indisponível (provedor de IA não configurado).']);
        return;
      }

      await historico.salvar(conn, tenantId, conversaId, 'user', { texto });
      let mensagens = await historico.carregar(conn, tenantId, conversaId);

      let respostaFinal = '';
      // Injeta a data/hora atual (Brasília) no system prompt — sem isso o modelo
      // não tem como interpretar "ontem", "este mês", "mês passado" corretamente.
      let hoje;
      try { hoje = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' }); }
      catch { hoje = new Date().toISOString(); }
      const sistema = `${carregarSistema()}\n\n---\nContexto do sistema: hoje é ${hoje} (horário de Brasília). Use esta data para resolver períodos relativos ("ontem", "este mês", "mês passado") e informe sempre o intervalo usado na resposta.`;
      // A chamada ao provedor (client.chamar) é o ponto mais provável de falhar
      // (chave, cota, modelo inexistente, rede, timeout). Um throw aqui NÃO pode
      // virar silêncio: capturamos, logamos com detalhe e caímos no fallback
      // amigável abaixo — que é SEMPRE enviado. (Erros de tool já são tratados no
      // try interno e voltam como resultado para o modelo.)
      try {
        for (let i = 0; i < MAX_ITER; i++) {
          const out = await client.chamar({ config, sistema, mensagens });
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
      if (!respostaFinal) respostaFinal = 'Não consegui responder agora — o assistente está indisponível no momento. Tente de novo em instantes.';
      await responder(conn, tenantId, cv, [respostaFinal]);
    });
  } catch (err) {
    console.error('[ia] runtime falhou:', err.message);
  }
}

module.exports = { processarEntrada };
