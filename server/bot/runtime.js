// bot/runtime.js — Casca com efeitos do chatbot: carrega conversa+fluxo,
// chama o engine puro, envia respostas (sendText), persiste mensagens de saída
// (ATENDENTE_ID NULL = bot), atualiza o estado BOT_* e executa transferência
// (fila + distribuidor) ou encerramento.
// Chamado SEMPRE fora da transação do webhook (pós-commit) e com try/catch
// isolado — falha do bot nunca derruba o processamento do webhook.
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
async function carregar(conn, conversaId) {
  const r = await conn.execute(
    `SELECT c.ID, c.CONTATO_ID, c.NUMERO_ID, c.FILA_STATUS, c.PROTOCOLO,
            c.BOT_FLUXO_ID, c.BOT_NO_ATUAL, c.BOT_VARIAVEIS, c.BOT_INVALIDAS,
            ct.TELEFONE, ct.NOME_PERFIL,
            n.PHONE_NUMBER_ID,
            f.DEFINICAO
       FROM MC_ZAP_CONVERSA c
       JOIN MC_ZAP_CONTATO ct ON ct.ID = c.CONTATO_ID
       LEFT JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
       LEFT JOIN MC_ZAP_FLUXO f ON f.ID = c.BOT_FLUXO_ID
      WHERE c.ID = :id`,
    { id: conversaId }
  );
  if (!r.rows.length) return null;
  const cv = r.rows[0];
  if (cv.FILA_STATUS !== 'bot' || !cv.DEFINICAO) return null; // proteção: bot só roda em estado bot

  let definicao;
  try {
    const raw = typeof cv.DEFINICAO === 'string' ? cv.DEFINICAO : await cv.DEFINICAO.getData();
    definicao = JSON.parse(raw);
  } catch (e) {
    console.error(`[bot] definição inválida do fluxo ${cv.BOT_FLUXO_ID}:`, e.message);
    return null;
  }
  return {
    conversaId: cv.ID, contatoId: cv.CONTATO_ID, numeroId: cv.NUMERO_ID,
    telefone: cv.TELEFONE, phoneNumberId: cv.PHONE_NUMBER_ID || undefined,
    protocolo: cv.PROTOCOLO,
    fluxo: definicao,
    estado: {
      noAtual: cv.BOT_NO_ATUAL,
      variaveis: cv.BOT_VARIAVEIS ? JSON.parse(cv.BOT_VARIAVEIS) : {},
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
      console.error('[bot] falha ao enviar (gravando STATUS=falha):', e.message);
    }
    await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM
         (CONVERSA_ID, CONTATO_ID, NUMERO_ID, WAMID, DIRECAO, TIPO, CONTEUDO, STATUS, TS)
       VALUES (:cv, :ct, :num, :wamid, 'out', 'text', :txt, :st, SYSTIMESTAMP)`,
      { cv: cv.conversaId, ct: cv.contatoId, num: cv.numeroId, wamid, txt, st: status }
    );
  }
}

/** Registra um evento do atendimento no AUDITORIA (best-effort; não derruba o fluxo).
    Alimenta a linha do tempo do Histórico (ex.: fila_fora_horario, fila_sem_agentes). */
async function auditarConversa(conn, conversaId, acao) {
  try {
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ACAO, ENTIDADE, ENTIDADE_ID) VALUES (:a, 'conversa', :id)`,
      { a: acao, id: conversaId }
    );
  } catch (e) { console.error('[bot] auditar conversa falhou:', e.message); }
}

/** Aplica o resultado do engine: estado, transferência ou encerramento. */
async function aplicar(conn, cv, resultado) {
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
      `INSERT INTO MC_ZAP_MENSAGEM (CONVERSA_ID, CONTATO_ID, DIRECAO, TIPO, CONTEUDO, TS)
       VALUES (:cv, :ct, 'nota', 'text', :txt, SYSTIMESTAMP)`,
      { cv: cv.conversaId, ct: cv.contatoId, txt: resumo }
    );
    await conn.execute(
      `UPDATE MC_ZAP_CONVERSA
          SET DEPARTAMENTO_ID = :dep, FILA_STATUS = 'aguardando', FILA_ENTROU_EM = SYSTIMESTAMP,
              BOT_NO_ATUAL = NULL, BOT_VARIAVEIS = :vars, BOT_ULTIMA_INTERACAO = SYSTIMESTAMP
        WHERE ID = :id AND FILA_STATUS = 'bot'`,
      { dep, vars: JSON.stringify(vars), id: cv.conversaId }
    );
    // Entrou na fila sem ninguém online no depto → registra o motivo (timeline).
    if (presence.onlineDoDepto(dep).length === 0) {
      await auditarConversa(conn, cv.conversaId, 'fila_sem_agentes');
    }
    await conn.commit();
    publish({ tipo: 'fila', conversaId: cv.conversaId, departamentoId: dep, protocolo: cv.protocolo });
    publish({ tipo: 'mensagem', direcao: 'out', conversaId: cv.conversaId, departamentoId: dep });
    distribuidor.atribuir(dep);
    return;
  }

  if (resultado.acao && resultado.acao.tipo === 'encerrar') {
    await conn.execute(
      `UPDATE MC_ZAP_CONVERSA
          SET STATUS = 'resolvida', FILA_STATUS = 'resolvida', RESOLVIDA_EM = SYSTIMESTAMP,
              BOT_NO_ATUAL = NULL, BOT_ULTIMA_INTERACAO = SYSTIMESTAMP
        WHERE ID = :id AND FILA_STATUS = 'bot'`,
      { id: cv.conversaId }
    );
    await conn.commit();
    publish({ tipo: 'conversa', conversaId: cv.conversaId, departamentoId: null });
    return;
  }

  // Continua no bot: persiste o novo estado.
  await conn.execute(
    `UPDATE MC_ZAP_CONVERSA
        SET BOT_NO_ATUAL = :no, BOT_VARIAVEIS = :vars, BOT_INVALIDAS = :inv,
            BOT_ULTIMA_INTERACAO = SYSTIMESTAMP
      WHERE ID = :id AND FILA_STATUS = 'bot'`,
    {
      no: resultado.estado.noAtual,
      vars: JSON.stringify(resultado.estado.variaveis || {}),
      inv: resultado.estado.invalidas || 0,
      id: cv.conversaId,
    }
  );
  await conn.commit();
  publish({ tipo: 'mensagem', direcao: 'out', conversaId: cv.conversaId, departamentoId: null });
}

/**
 * Executa o SELECT de um nó 'consulta' com binds vindos das variáveis
 * capturadas (:codigo_rca etc). Devolve { encontrado, vars } — as colunas da
 * 1ª linha viram variáveis em minúsculas (ex.: {{nome}}).
 * Erro de SQL é tratado como "não encontrado" (o fluxo segue o caminho de
 * falha em vez de travar o cliente), com log alto pro admin corrigir.
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
    // cliente). O `erro` é devolvido pra o SIMULADOR exibir ao admin — ORA-00942
    // (falta GRANT), nome de tabela errado, etc. ficam óbvios no teste.
    console.error(`[bot] consulta "${no.id}" falhou (seguindo caminho de não-encontrado):`, err.message);
    return { encontrado: false, vars: {}, erro: err.message };
  }
}

/** Resolve ações intermediárias em cadeia (máx. 5): consultas ao banco e saltos
    para outro fluxo (irFluxo preserva variáveis). */
async function resolverConsultas(conn, cv, resultado) {
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
          `SELECT ID, DEFINICAO FROM MC_ZAP_FLUXO
            WHERE UPPER(NOME) = UPPER(:nome)
            ORDER BY ATIVO DESC, ID DESC FETCH FIRST 1 ROWS ONLY`,
          { nome: r.acao.fluxo }
        );
      } else {
        sel = await conn.execute(
          `SELECT ID, DEFINICAO FROM MC_ZAP_FLUXO WHERE ID = :id`, { id: Number(r.acao.fluxoId) }
        );
      }
      if (!sel.rows.length) {
        console.error(`[bot] irFluxo: destino "${r.acao.fluxo || r.acao.fluxoId}" não existe — encerrando por segurança.`);
        r = { mensagens: [], estado: { ...r.estado, noAtual: null }, acao: { tipo: 'encerrar' } };
      } else {
        const fluxoId = sel.rows[0].ID;
        const raw = typeof sel.rows[0].DEFINICAO === 'string'
          ? sel.rows[0].DEFINICAO : await sel.rows[0].DEFINICAO.getData();
        const novoFluxo = JSON.parse(raw);
        await conn.execute(
          `UPDATE MC_ZAP_CONVERSA SET BOT_FLUXO_ID = :f WHERE ID = :id AND FILA_STATUS = 'bot'`,
          { f: fluxoId, id: cv.conversaId }
        );
        cv.fluxo = novoFluxo; // próximas iterações/persistência usam o novo
        r = engine.iniciar(novoFluxo, cv.contexto, r.estado.variaveis || {});
      }
    }
    mensagens = mensagens.concat(r.mensagens);
  }
  return { ...r, mensagens };
}

async function executar(conversaId, fn) {
  let conn;
  try {
    conn = await db.getConnection();
    const cv = await carregar(conn, conversaId);
    if (!cv) return;
    let resultado = fn(cv);
    resultado = await resolverConsultas(conn, cv, resultado);
    await aplicar(conn, cv, resultado);
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error(`[bot] erro na conversa ${conversaId}:`, err.message);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/** Saudação: conversa nova entrou em estado bot. */
function iniciarFluxo(conversaId) {
  return executar(conversaId, (cv) => engine.iniciar(cv.fluxo, cv.contexto));
}

/** Resposta do cliente numa conversa em bot. */
function processarEntrada(conversaId, texto) {
  return executar(conversaId, (cv) => engine.avancar(cv.fluxo, cv.estado, texto, cv.contexto));
}

/** Timeout de inatividade (chamado pelo sweeper). */
function expirar(conversaId) {
  return executar(conversaId, (cv) => engine.aoExpirar(cv.fluxo, cv.estado, cv.contexto));
}

module.exports = { iniciarFluxo, processarEntrada, expirar, executarConsulta };
