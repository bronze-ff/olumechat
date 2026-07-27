// bot/runtime.js — Casca com efeitos do chatbot: carrega conversa+fluxo,
// chama o engine puro, envia respostas (sendText), persiste mensagens de saída
// (atendente_id NULL = bot), atualiza o estado bot_* e executa transferência
// (fila + distribuidor) ou encerramento.
// Chamado SEMPRE fora da transação do webhook (pós-commit) e com try/catch
// isolado — falha do bot nunca derruba o processamento do webhook.
//
// tenantId é 1º parâmetro em toda função pública: um fluxo/conversa pertence a
// um tenant e comTenant() precisa saber qual ANTES de abrir a conexão (RLS não
// tem acesso "sem tenant"). Quem resolve o tenant a partir do phone_number_id é
// a borda do webhook (FIL-60) — runtime.js só recebe, nunca faz lookup aqui
// (um lookup próprio reabriria o bypass de RLS que comTenant() fecha).
'use strict';

const db = require('../db/pool');
const engine = require('./engine');
const { sendText } = require('../graph/sendText');
const { publish } = require('../realtime/hub');
const distribuidor = require('../fila/distribuidor');
const { lerConfig } = require('../utils/configCache');
const { foraDeHorario } = require('../utils/horario');
const presence = require('../realtime/presence');

/** Carrega tudo que o engine precisa. Devolve null se a conversa não está em bot. */
async function carregar(conn, tenantId, conversaId) {
  const r = await conn.execute(
    `SELECT c.id, c.contato_id, c.numero_id, c.fila_status, c.protocolo,
            c.bot_fluxo_id, c.bot_no_atual, c.bot_variaveis, c.bot_invalidas,
            ct.telefone, ct.nome_perfil,
            n.phone_number_id,
            f.definicao
       FROM conversa c
       JOIN contato ct ON ct.id = c.contato_id
       LEFT JOIN numero n ON n.id = c.numero_id
       LEFT JOIN fluxo f ON f.id = c.bot_fluxo_id
      WHERE c.id = :id AND c.tenant_id = :tid`,
    { id: conversaId, tid: tenantId }
  );
  if (!r.rows.length) return null;
  const cv = r.rows[0];
  if (cv.FILA_STATUS !== 'bot' || !cv.DEFINICAO) return null; // proteção: bot só roda em estado bot

  // DEFINICAO/BOT_VARIAVEIS são jsonb — o driver pg já devolve objeto (não string).
  return {
    conversaId: cv.ID, contatoId: cv.CONTATO_ID, numeroId: cv.NUMERO_ID,
    telefone: cv.TELEFONE, phoneNumberId: cv.PHONE_NUMBER_ID || undefined,
    protocolo: cv.PROTOCOLO,
    fluxo: cv.DEFINICAO,
    estado: {
      noAtual: cv.BOT_NO_ATUAL,
      variaveis: cv.BOT_VARIAVEIS || {},
      invalidas: cv.BOT_INVALIDAS || 0,
    },
    contexto: { nome: cv.NOME_PERFIL || 'cliente', protocolo: cv.PROTOCOLO || '' },
  };
}

/** Envia e persiste as mensagens do bot. */
async function enviarMensagens(conn, cv, mensagens) {
  for (const txt of mensagens) {
    let wamid = null;
    let status = 'sent';
    try {
      const resp = await sendText(cv.telefone, txt, cv.phoneNumberId);
      wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
    } catch (e) {
      // Não entregou: grava 'falha' (não 'sent') — senão o histórico afirma um
      // envio que não ocorreu e nenhum webhook de status corrige (sem WAMID).
      status = 'falha';
      console.error('[bot] falha ao enviar (gravando status=falha):', e.message);
    }
    await conn.execute(
      `INSERT INTO mensagem
         (conversa_id, contato_id, numero_id, wamid, direcao, tipo, conteudo, status, ts)
       VALUES (:cv, :ct, :num, :wamid, 'out', 'text', :txt, :st, now())`,
      { cv: cv.conversaId, ct: cv.contatoId, num: cv.numeroId, wamid, txt, st: status }
    );
  }
}

/** Registra um evento do atendimento no AUDITORIA (best-effort; não derruba o fluxo).
    Alimenta a linha do tempo do Histórico (ex.: fila_fora_horario, fila_sem_agentes). */
async function auditarConversa(conn, conversaId, acao) {
  try {
    await conn.execute(
      `INSERT INTO auditoria (acao, entidade, entidade_id) VALUES (:a, 'conversa', :id)`,
      { a: acao, id: conversaId }
    );
  } catch (e) { console.error('[bot] auditar conversa falhou:', e.message); }
}

/** Aplica o resultado do engine: estado, transferência ou encerramento. */
async function aplicar(conn, tenantId, cv, resultado) {
  await enviarMensagens(conn, cv, resultado.mensagens);

  if (resultado.acao && resultado.acao.tipo === 'transferir') {
    const dep = resultado.acao.departamentoId;
    // Handoff pra HUMANO fora do horário: o bot self-service roda 24/7, mas ao
    // passar pra fila avisa que o time está fora do expediente — senão o cliente
    // fica esperando achando que vão responder na hora. Isolado: não derruba o transfer.
    try {
      const cfg = await lerConfig(conn);
      const fora = foraDeHorario(cfg, new Date());
      if (fora && String(cfg.fora_horario_msg || '').trim()) {
        await enviarMensagens(conn, cv, [String(cfg.fora_horario_msg).trim()]);
      }
      if (fora) await auditarConversa(conn, cv.conversaId, 'fila_fora_horario');
    } catch (e) { console.error('[bot] aviso de fora de horário no transfer falhou:', e.message); }
    // Nota interna com o que o bot capturou (contexto pro atendente).
    const vars = resultado.estado.variaveis || {};
    const resumo = Object.keys(vars).length
      ? `Bot: dados capturados — ${Object.entries(vars).map(([k, v]) => `${k}: ${v}`).join(' · ')}`
      : 'Bot: cliente encaminhado pelo autoatendimento.';
    await conn.execute(
      `INSERT INTO mensagem (conversa_id, contato_id, direcao, tipo, conteudo, ts)
       VALUES (:cv, :ct, 'nota', 'text', :txt, now())`,
      { cv: cv.conversaId, ct: cv.contatoId, txt: resumo }
    );
    await conn.execute(
      `UPDATE conversa
          SET departamento_id = :dep, fila_status = 'aguardando', fila_entrou_em = now(),
              bot_no_atual = NULL, bot_variaveis = :vars, bot_ultima_interacao = now()
        WHERE id = :id AND fila_status = 'bot' AND tenant_id = :tid`,
      { dep, vars: JSON.stringify(vars), id: cv.conversaId, tid: tenantId }
    );
    // Entrou na fila sem ninguém online no depto → registra o motivo (timeline).
    if (presence.onlineDoDepto(dep).length === 0) {
      await auditarConversa(conn, cv.conversaId, 'fila_sem_agentes');
    }
    publish({ tipo: 'fila', conversaId: cv.conversaId, departamentoId: dep, protocolo: cv.protocolo });
    publish({ tipo: 'mensagem', direcao: 'out', conversaId: cv.conversaId, departamentoId: dep });
    distribuidor.atribuir(dep);
    return;
  }

  if (resultado.acao && resultado.acao.tipo === 'encerrar') {
    await conn.execute(
      `UPDATE conversa
          SET status = 'resolvida', fila_status = 'resolvida', resolvida_em = now(),
              bot_no_atual = NULL, bot_ultima_interacao = now()
        WHERE id = :id AND fila_status = 'bot' AND tenant_id = :tid`,
      { id: cv.conversaId, tid: tenantId }
    );
    publish({ tipo: 'conversa', conversaId: cv.conversaId, departamentoId: null });
    return;
  }

  // Continua no bot: persiste o novo estado.
  await conn.execute(
    `UPDATE conversa
        SET bot_no_atual = :no, bot_variaveis = :vars, bot_invalidas = :inv,
            bot_ultima_interacao = now()
      WHERE id = :id AND fila_status = 'bot' AND tenant_id = :tid`,
    {
      no: resultado.estado.noAtual,
      vars: JSON.stringify(resultado.estado.variaveis || {}),
      inv: resultado.estado.invalidas || 0,
      id: cv.conversaId,
      tid: tenantId,
    }
  );
  publish({ tipo: 'mensagem', direcao: 'out', conversaId: cv.conversaId, departamentoId: null });
}

/**
 * Executa o SELECT de um nó 'consulta' com binds vindos das variáveis
 * capturadas (:codigo_rca etc). Devolve { encontrado, vars } — as colunas da
 * 1ª linha viram variáveis em minúsculas (ex.: {{nome}}).
 * Erro de SQL é tratado como "não encontrado" (o fluxo segue o caminho de
 * falha em vez de travar o cliente), com log alto pro admin corrigir.
 * `conn` já está dentro de um comTenant() do chamador — a RLS confina o SELECT
 * livre do admin ao tenant corrente mesmo sem filtro explícito na query dele.
 */
async function executarConsulta(conn, no, variaveis) {
  const sql = String(no.sql || '').trim();
  if (!/^select\s/i.test(sql) || sql.includes(';')) {
    console.error(`[bot] consulta "${no.id}": SQL inválido (só SELECT, sem ';').`);
    return { encontrado: false, vars: {} };
  }
  const binds = {};
  for (const m of sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    const nome = m[1];
    if (!(nome in binds)) binds[nome] = variaveis[nome] !== undefined ? String(variaveis[nome]) : null;
  }
  try {
    const r = await conn.execute(sql, binds);
    if (!r.rows || !r.rows.length) return { encontrado: false, vars: {} };
    const vars = {};
    for (const [col, val] of Object.entries(r.rows[0])) {
      if (val !== null && val !== undefined) vars[col.toLowerCase()] = String(val);
    }
    return { encontrado: true, vars };
  } catch (err) {
    // Em produção, erro de SQL segue o caminho de "não encontrado" (não trava o
    // cliente). O `erro` é devolvido pra o SIMULADOR exibir ao admin — erro de
    // sintaxe, nome de tabela errado, etc. ficam óbvios no teste.
    console.error(`[bot] consulta "${no.id}" falhou (seguindo caminho de não-encontrado):`, err.message);
    return { encontrado: false, vars: {}, erro: err.message };
  }
}

/** Resolve ações intermediárias em cadeia (máx. 5): consultas ao banco e saltos
    para outro fluxo (irFluxo preserva variáveis). */
async function resolverConsultas(conn, tenantId, cv, resultado) {
  let r = resultado;
  let mensagens = [...r.mensagens];
  let voltas = 0;
  while (r.acao && ['consulta', 'irFluxo'].includes(r.acao.tipo) && voltas++ < 5) {
    if (r.acao.tipo === 'consulta') {
      const { encontrado, vars } = await executarConsulta(conn, r.acao.no, r.estado.variaveis || {});
      r = engine.continuarAposConsulta(cv.fluxo, r.estado, encontrado, vars, cv.contexto);
    } else if (r.acao.tipo === 'irFluxo') {
      // irFluxo: carrega o destino (por NOME — portável; ou por ID legado),
      // aponta a conversa pra ele e inicia preservando as variáveis capturadas.
      let sel;
      if (r.acao.fluxo) {
        sel = await conn.execute(
          `SELECT id, definicao FROM fluxo
            WHERE tenant_id = :tid AND upper(nome) = upper(:nome)
            ORDER BY ativo DESC, id DESC LIMIT 1`,
          { tid: tenantId, nome: r.acao.fluxo }
        );
      } else {
        sel = await conn.execute(
          `SELECT id, definicao FROM fluxo WHERE id = :id AND tenant_id = :tid`,
          { id: Number(r.acao.fluxoId), tid: tenantId }
        );
      }
      if (!sel.rows.length) {
        console.error(`[bot] irFluxo: destino "${r.acao.fluxo || r.acao.fluxoId}" não existe — encerrando por segurança.`);
        r = { mensagens: [], estado: { ...r.estado, noAtual: null }, acao: { tipo: 'encerrar' } };
      } else {
        const fluxoId = sel.rows[0].ID;
        const novoFluxo = sel.rows[0].DEFINICAO; // jsonb já vem parseado
        await conn.execute(
          `UPDATE conversa SET bot_fluxo_id = :f WHERE id = :id AND fila_status = 'bot' AND tenant_id = :tid`,
          { f: fluxoId, id: cv.conversaId, tid: tenantId }
        );
        cv.fluxo = novoFluxo; // próximas iterações/persistência usam o novo
        r = engine.iniciar(novoFluxo, cv.contexto, r.estado.variaveis || {});
      }
    }
    mensagens = mensagens.concat(r.mensagens);
  }
  return { ...r, mensagens };
}

async function executar(tenantId, conversaId, fn) {
  try {
    await db.comTenant(tenantId, async (conn) => {
      const cv = await carregar(conn, tenantId, conversaId);
      if (!cv) return;
      let resultado = fn(cv);
      resultado = await resolverConsultas(conn, tenantId, cv, resultado);
      await aplicar(conn, tenantId, cv, resultado);
    });
  } catch (err) {
    console.error(`[bot] erro na conversa ${conversaId} (tenant ${tenantId}):`, err.message);
  }
}

/** Saudação: conversa nova entrou em estado bot. */
function iniciarFluxo(tenantId, conversaId) {
  return executar(tenantId, conversaId, (cv) => engine.iniciar(cv.fluxo, cv.contexto));
}

/** Resposta do cliente numa conversa em bot. */
function processarEntrada(tenantId, conversaId, texto) {
  return executar(tenantId, conversaId, (cv) => engine.avancar(cv.fluxo, cv.estado, texto, cv.contexto));
}

/** Timeout de inatividade (chamado pelo sweeper). */
function expirar(tenantId, conversaId) {
  return executar(tenantId, conversaId, (cv) => engine.aoExpirar(cv.fluxo, cv.estado, cv.contexto));
}

module.exports = { iniciarFluxo, processarEntrada, expirar, executarConsulta };
