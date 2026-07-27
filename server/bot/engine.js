// bot/engine.js — Motor PURO do chatbot (sem DB, sem fetch — 100% testável).
//
// Fluxo = { config: { inicio, timeoutMin, acaoTimeout, msgOpcaoInvalida,
//                     maxInvalidas, acaoMaxInvalidas }, nos: [...] }
// Nós (7 tipos):
//   mensagem  { id, texto, proximo }                 — envia e segue
//   menu      { id, texto, opcoes: [{valor, rotulo?, proximo}] } — envia e espera
//   pergunta  { id, texto, variavel, validacao?, msgInvalida?, proximo } — espera
//   consulta  { id, sql, seEncontrado, seNaoEncontrado } — SELECT no Oracle com
//              binds :variavel; achou → colunas viram variáveis e segue
//              seEncontrado; não achou → seNaoEncontrado. O engine é PURO:
//              ele PARA devolvendo acao {tipo:'consulta', no} e o runtime
//              executa o SQL e retoma com continuarAposConsulta().
//   transferir{ id, departamentoId, texto? }          — encaminha pra fila
//   encerrar  { id, texto? }                          — finaliza o atendimento
//   irfluxo   { id, fluxoId }                         — pula para OUTRO fluxo
//              (acao {tipo:'irFluxo'}; o runtime troca BOT_FLUXO_ID e inicia
//              o fluxo destino preservando as variáveis capturadas)
// Placeholders no texto: {{nome}}, {{protocolo}} e {{variavel_capturada}}.
//
// Estado = { noAtual, variaveis: {}, invalidas: 0 }
// Resultado = { mensagens: string[], estado, acao: null
//             | { tipo:'transferir', departamentoId } | { tipo:'encerrar' } }
'use strict';

const { validarSQL } = require('./sqlValidator');

const MAX_PASSOS = 20; // guarda contra loop de nós 'mensagem' na definição

function noPorId(fluxo, id) {
  return (fluxo.nos || []).find((n) => n.id === id) || null;
}

function render(texto, contexto, variaveis) {
  return String(texto || '').replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, chave) => {
    // Variável capturada/consultada VENCE o contexto: se uma consulta trouxe a
    // coluna NOME (cadastro), ela vale mais que o nome do perfil do WhatsApp.
    if (variaveis && variaveis[chave] !== undefined) return String(variaveis[chave]);
    if (contexto && contexto[chave] !== undefined && contexto[chave] !== null) return String(contexto[chave]);
    return `{{${chave}}}`;
  });
}

function validarResposta(no, texto) {
  const t = String(texto || '').trim();
  if (!t) return false;
  switch (no.validacao) {
    case 'numero': return /^\d+$/.test(t.replace(/\D/g, '')) && /\d/.test(t);
    case 'cpf_cnpj': { const d = t.replace(/\D/g, ''); return d.length === 11 || d.length === 14; }
    case 'regex': try { return new RegExp(no.regex).test(t); } catch { return true; }
    default: return true; // 'texto' ou ausente: qualquer coisa não-vazia
  }
}

/**
 * Caminha a partir de um nó: emite mensagens até parar num nó de espera
 * (menu/pergunta) ou num terminal (transferir/encerrar).
 */
function caminhar(fluxo, idInicial, estado, contexto, mensagens) {
  let atual = noPorId(fluxo, idInicial);
  let passos = 0;

  while (atual && passos++ < MAX_PASSOS) {
    const txt = atual.texto ? render(atual.texto, contexto, estado.variaveis) : '';
    switch (atual.tipo) {
      case 'mensagem':
        if (txt) mensagens.push(txt);
        atual = noPorId(fluxo, atual.proximo);
        break;
      case 'menu':
      case 'pergunta':
        if (txt) mensagens.push(txt);
        return { mensagens, estado: { ...estado, noAtual: atual.id }, acao: null };
      case 'consulta':
        // Efeito (SQL) é do runtime: para aqui e devolve a ação pendente.
        return {
          mensagens, estado: { ...estado, noAtual: atual.id },
          acao: { tipo: 'consulta', no: atual },
        };
      case 'irfluxo':
        if (txt) mensagens.push(txt);
        return {
          mensagens, estado: { ...estado, noAtual: null },
          // 'fluxo' (nome) é a referência portável; fluxoId é fallback legado.
          acao: { tipo: 'irFluxo', fluxo: atual.fluxo, fluxoId: atual.fluxoId },
        };
      case 'transferir':
        if (txt) mensagens.push(txt);
        return {
          mensagens, estado: { ...estado, noAtual: null },
          acao: { tipo: 'transferir', departamentoId: atual.departamentoId },
        };
      case 'encerrar':
        if (txt) mensagens.push(txt);
        return { mensagens, estado: { ...estado, noAtual: null }, acao: { tipo: 'encerrar' } };
      default:
        atual = null; // tipo desconhecido: para sem ação (defensivo)
    }
  }
  // Sem nó / loop estourado: encerra por segurança.
  return { mensagens, estado: { ...estado, noAtual: null }, acao: { tipo: 'encerrar' } };
}

/** Inicia o fluxo (saudação): caminha a partir de config.inicio.
    variaveisIniciais preserva o que já foi capturado num fluxo anterior. */
function iniciar(fluxo, contexto, variaveisIniciais) {
  const estado = { noAtual: null, variaveis: { ...(variaveisIniciais || {}) }, invalidas: 0 };
  return caminhar(fluxo, fluxo.config && fluxo.config.inicio, estado, contexto, []);
}

/** Executa a ação configurada (timeout / máx. inválidas). */
function executarAcao(fluxo, acaoCfg, estado, contexto, mensagens) {
  if (acaoCfg && acaoCfg.tipo === 'transferir') {
    if (acaoCfg.texto) mensagens.push(render(acaoCfg.texto, contexto, estado.variaveis));
    return {
      mensagens, estado: { ...estado, noAtual: null },
      acao: { tipo: 'transferir', departamentoId: acaoCfg.departamentoId },
    };
  }
  if (acaoCfg && acaoCfg.texto) mensagens.push(render(acaoCfg.texto, contexto, estado.variaveis));
  return { mensagens, estado: { ...estado, noAtual: null }, acao: { tipo: 'encerrar' } };
}

/**
 * Processa a RESPOSTA do cliente estando num nó de espera (menu/pergunta).
 */
function avancar(fluxo, estado, textoEntrada, contexto) {
  const cfg = fluxo.config || {};
  const no = noPorId(fluxo, estado.noAtual);
  if (!no) return iniciar(fluxo, contexto); // estado perdido: recomeça

  const entrada = String(textoEntrada || '').trim();
  const mensagens = [];

  if (no.tipo === 'menu') {
    const opcao = (no.opcoes || []).find((o) => String(o.valor).trim() === entrada);
    if (opcao) {
      const novoEstado = { ...estado, invalidas: 0 };
      return caminhar(fluxo, opcao.proximo, novoEstado, contexto, mensagens);
    }
    const invalidas = (estado.invalidas || 0) + 1;
    if (invalidas >= (cfg.maxInvalidas || 3)) {
      return executarAcao(fluxo, cfg.acaoMaxInvalidas, { ...estado, invalidas }, contexto, mensagens);
    }
    mensagens.push(render(cfg.msgOpcaoInvalida || 'Opção inválida. Digite o número de uma das opções.', contexto, estado.variaveis));
    if (no.texto) mensagens.push(render(no.texto, contexto, estado.variaveis)); // re-mostra o menu
    return { mensagens, estado: { ...estado, invalidas }, acao: null };
  }

  if (no.tipo === 'pergunta') {
    if (validarResposta(no, entrada)) {
      const variaveis = { ...estado.variaveis, [no.variavel || 'resposta']: entrada };
      const novoEstado = { ...estado, variaveis, invalidas: 0 };
      return caminhar(fluxo, no.proximo, novoEstado, contexto, mensagens);
    }
    const invalidas = (estado.invalidas || 0) + 1;
    if (invalidas >= (cfg.maxInvalidas || 3)) {
      return executarAcao(fluxo, cfg.acaoMaxInvalidas, { ...estado, invalidas }, contexto, mensagens);
    }
    mensagens.push(render(no.msgInvalida || 'Resposta inválida, tente novamente.', contexto, estado.variaveis));
    return { mensagens, estado: { ...estado, invalidas }, acao: null };
  }

  // Conversa parada num nó de consulta (ex.: restart no meio): re-executa.
  if (no.tipo === 'consulta') {
    return { mensagens, estado, acao: { tipo: 'consulta', no } };
  }

  // Nó de espera inválido (definição mudou?): recomeça o fluxo.
  return iniciar(fluxo, contexto);
}

/**
 * Retoma o fluxo após o runtime executar a consulta ao banco.
 * @param {boolean} encontrado      O SELECT trouxe linha?
 * @param {object}  novasVariaveis  Colunas da 1ª linha (minúsculas) → valores.
 */
function continuarAposConsulta(fluxo, estado, encontrado, novasVariaveis, contexto) {
  const no = noPorId(fluxo, estado.noAtual);
  if (!no || no.tipo !== 'consulta') return iniciar(fluxo, contexto);
  const variaveis = { ...estado.variaveis, ...(encontrado ? novasVariaveis : {}) };
  const novoEstado = { ...estado, variaveis, invalidas: 0 };
  const destino = encontrado ? no.seEncontrado : no.seNaoEncontrado;
  return caminhar(fluxo, destino, novoEstado, contexto, []);
}

/** Timeout de inatividade: executa config.acaoTimeout. */
function aoExpirar(fluxo, estado, contexto) {
  return executarAcao(fluxo, (fluxo.config || {}).acaoTimeout, estado || { variaveis: {} }, contexto, []);
}

/**
 * Valida a definição de um fluxo. Devolve lista de erros (vazia = ok).
 */
function validarFluxo(def) {
  const erros = [];
  if (!def || typeof def !== 'object') return ['Definição vazia ou inválida.'];
  const cfg = def.config || {};
  const nos = Array.isArray(def.nos) ? def.nos : [];
  if (!nos.length) erros.push('O fluxo precisa de pelo menos um passo.');

  const ids = new Set();
  for (const n of nos) {
    if (!n.id) erros.push('Há um passo sem identificador.');
    else if (ids.has(n.id)) erros.push(`Passo duplicado: "${n.id}".`);
    else ids.add(n.id);
    if (!['mensagem', 'menu', 'pergunta', 'consulta', 'transferir', 'encerrar', 'irfluxo'].includes(n.tipo)) {
      erros.push(`Passo "${n.id}": tipo desconhecido (${n.tipo}).`);
    }
  }
  if (!cfg.inicio) erros.push('Defina o passo inicial (config.inicio).');
  else if (!ids.has(cfg.inicio)) erros.push(`Passo inicial "${cfg.inicio}" não existe.`);

  const refs = [];
  for (const n of nos) {
    if (n.tipo === 'mensagem' || n.tipo === 'pergunta') refs.push([n.id, n.proximo]);
    if (n.tipo === 'menu') {
      if (!Array.isArray(n.opcoes) || !n.opcoes.length) erros.push(`Menu "${n.id}" sem opções.`);
      for (const o of n.opcoes || []) refs.push([n.id, o.proximo]);
    }
    if (n.tipo === 'transferir' && !n.departamentoId) erros.push(`Passo "${n.id}": escolha o departamento.`);
    if (n.tipo === 'pergunta' && !n.variavel) erros.push(`Pergunta "${n.id}": defina o nome da variável.`);
    if (n.tipo === 'irfluxo' && !n.fluxo && !n.fluxoId) erros.push(`Passo "${n.id}": escolha o fluxo de destino.`);
    if (n.tipo === 'consulta') {
      for (const msg of validarSQL(n.sql)) erros.push(`Consulta "${n.id}": ${msg}`);
      refs.push([n.id, n.seEncontrado]);
      refs.push([n.id, n.seNaoEncontrado]);
    }
  }
  for (const [de, para] of refs) {
    if (!para) erros.push(`Passo "${de}": defina o próximo passo.`);
    else if (!ids.has(para)) erros.push(`Passo "${de}" aponta para "${para}", que não existe.`);
  }

  // Alcançabilidade a partir do início.
  if (cfg.inicio && ids.has(cfg.inicio)) {
    const visitados = new Set();
    const pilha = [cfg.inicio];
    while (pilha.length) {
      const id = pilha.pop();
      if (visitados.has(id)) continue;
      visitados.add(id);
      const n = nos.find((x) => x.id === id);
      if (!n) continue;
      if (n.proximo) pilha.push(n.proximo);
      if (n.seEncontrado) pilha.push(n.seEncontrado);
      if (n.seNaoEncontrado) pilha.push(n.seNaoEncontrado);
      for (const o of n.opcoes || []) if (o.proximo) pilha.push(o.proximo);
    }
    for (const id of ids) {
      if (!visitados.has(id)) erros.push(`Passo "${id}" nunca é alcançado a partir do início.`);
    }
  }
  return erros;
}

module.exports = {
  iniciar, avancar, aoExpirar, continuarAposConsulta, validarFluxo, render,
};
