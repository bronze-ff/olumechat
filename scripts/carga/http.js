// scripts/carga/http.js — Cliente HTTP mínimo do harness de carga (FIL-110).
//
// Node puro (`node:http`/`node:https`), sem dependência nova: o harness precisa
// rodar em qualquer máquina e dentro do container, e uma lib de carga (autocannon,
// k6) não abre SSE autenticado por ticket de uso único — que é justamente o
// cenário que mais importa medir aqui.
//
// Duas escolhas que afetam a medição:
//
// 1. `maxSockets: Infinity` — com o default do Node (Infinity para http.Agent
//    global, mas 5 em alguns runtimes/proxies) a fila seria do CLIENTE, e o
//    número medido viraria o limite do harness, não o do servidor.
// 2. Cabeçalhos do Cloudflare Access saem do AMBIENTE (`CF_ACCESS_CLIENT_ID` /
//    `CF_ACCESS_CLIENT_SECRET`), nunca de arquivo versionado. Sem eles, staging
//    devolve 302 para a tela de login e o harness diz isso em voz alta em vez de
//    contabilizar o 302 como "resposta do servidor".
'use strict';

const http = require('node:http');
const https = require('node:https');
const { urlDe } = require('./alvo');

const agentes = new Map();

/** Um agente keep-alive por origem, com socket ilimitado (ver cabeçalho). */
function agenteDe(url) {
  const chave = url.origin;
  if (!agentes.has(chave)) {
    const Mod = url.protocol === 'https:' ? https : http;
    agentes.set(chave, new Mod.Agent({
      keepAlive: true,
      maxSockets: Infinity,
      maxFreeSockets: 256,
      timeout: 0,
    }));
  }
  return agentes.get(chave);
}

/** Cabeçalhos do service token do Cloudflare Access, se presentes no ambiente. */
function cabecalhosAccess() {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const segredo = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !segredo) return {};
  return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': segredo };
}

/**
 * Requisição simples com corpo JSON opcional. Devolve status, cabeçalhos, corpo
 * cru e o tempo de ida e volta em ms (medido com hrtime, não Date).
 */
function pedir(alvo, caminho, { metodo = 'GET', corpo = null, cabecalhos = {}, timeoutMs = 30_000 } = {}) {
  const url = urlDe(alvo, caminho);
  const Mod = url.protocol === 'https:' ? https : http;
  const dados = corpo == null ? null : Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));

  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = Mod.request(url, {
      method: metodo,
      agent: agenteDe(url),
      headers: {
        Accept: 'application/json',
        ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}),
        ...cabecalhosAccess(),
        ...cabecalhos,
      },
    }, (res) => {
      const pedacos = [];
      res.on('data', (d) => pedacos.push(d));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        resolve({
          status: res.statusCode,
          cabecalhos: res.headers,
          corpo: Buffer.concat(pedacos).toString('utf8'),
          ms,
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

/** `pedir` + JSON.parse tolerante (corpo não-JSON vira `null`, sem estourar). */
async function pedirJson(alvo, caminho, opcoes) {
  const r = await pedir(alvo, caminho, opcoes);
  let json = null;
  try { json = JSON.parse(r.corpo); } catch { /* HTML de login do Access, por ex. */ }
  return { ...r, json };
}

/**
 * Diagnóstico do 302/403 do Cloudflare Access. Chamado antes de qualquer
 * cenário: contabilizar a tela de login como "resposta do servidor" produziria
 * um relatório que mede o Cloudflare, não o Olume.
 */
function explicarAcesso(resposta) {
  if (resposta.status === 302 || resposta.status === 403) {
    const temToken = Boolean(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET);
    return temToken
      ? `HTTP ${resposta.status} mesmo com service token — a política do Access provavelmente não cobre este caminho.`
      : `HTTP ${resposta.status} — alvo atrás do Cloudflare Access e sem CF_ACCESS_CLIENT_ID/SECRET no ambiente.`;
  }
  return null;
}

function encerrarAgentes() {
  for (const a of agentes.values()) a.destroy();
  agentes.clear();
}

module.exports = { pedir, pedirJson, explicarAcesso, encerrarAgentes, agenteDe, cabecalhosAccess };
