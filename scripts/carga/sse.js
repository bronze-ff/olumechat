// scripts/carga/sse.js — Cliente SSE do harness (FIL-110).
//
// Fluxo real do produto (api/stream.js), sem atalho:
//   POST /api/auth/login          → JWT do usuário
//   POST /api/stream/ticket       → ticket de USO ÚNICO (um por conexão)
//   GET  /api/stream?ticket=...   → o stream
//
// Ticket de uso único é o motivo de o harness não usar autocannon/k6: cada
// conexão precisa de uma chamada autenticada antes de abrir. E é uma medição
// em si — no pico de reconexão (rolling update) o servidor leva um POST
// /ticket + um carregarPerfil() (consulta ao banco) POR conexão.
//
// O relógio de cada evento é `process.hrtime.bigint()` do processo do harness;
// latência de entrega é medida ponta a ponta contra o instante em que o gatilho
// foi ENVIADO, e não contra um timestamp gerado no servidor — o harness não
// altera o produto para se instrumentar.
'use strict';

const http = require('node:http');
const https = require('node:https');
const { agenteDe, cabecalhosAccess } = require('./http');
const { urlDe } = require('./alvo');

class ConexaoSse {
  /**
   * @param {URL} alvo
   * @param {string} ticket
   * @param {(evento: object, recebidoEm: bigint) => void} aoEvento
   */
  constructor(alvo, ticket, aoEvento) {
    this.alvo = alvo;
    this.ticket = ticket;
    this.aoEvento = aoEvento;
    this.req = null;
    this.res = null;
    this.buffer = '';
    this.erro = null;
    this.fechada = false;
    this.msAteReady = null;
    this.eventos = 0;
  }

  /** Resolve quando o `event: ready` chega (ou rejeita com o status HTTP). */
  abrir({ timeoutMs = 30_000 } = {}) {
    const url = urlDe(this.alvo, `/api/stream?ticket=${encodeURIComponent(this.ticket)}`);
    const Mod = url.protocol === 'https:' ? https : http;
    const t0 = process.hrtime.bigint();

    return new Promise((resolve, reject) => {
      let pronto = false;
      const req = Mod.request(url, {
        method: 'GET',
        agent: agenteDe(url),
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...cabecalhosAccess() },
      }, (res) => {
        this.res = res;
        if (res.statusCode !== 200) {
          const pedacos = [];
          res.on('data', (d) => pedacos.push(d));
          res.on('end', () => {
            this.fechada = true;
            reject(Object.assign(new Error(`SSE HTTP ${res.statusCode}`), {
              status: res.statusCode,
              corpo: Buffer.concat(pedacos).toString('utf8').slice(0, 300),
            }));
          });
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (pedaco) => {
          const agora = process.hrtime.bigint();
          this.buffer += pedaco;
          let corte;
          while ((corte = this.buffer.indexOf('\n\n')) !== -1) {
            const bruto = this.buffer.slice(0, corte);
            this.buffer = this.buffer.slice(corte + 2);
            const evento = analisar(bruto);
            if (!evento) continue; // `: ping` (comentário/heartbeat)
            this.eventos += 1;
            if (evento.nome === 'ready' && !pronto) {
              pronto = true;
              this.msAteReady = Number(agora - t0) / 1e6;
              resolve(this);
              continue;
            }
            if (this.aoEvento) this.aoEvento(evento, agora);
          }
        });
        res.on('end', () => { this.fechada = true; });
        res.on('error', (e) => { this.erro = e; this.fechada = true; });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms abrindo SSE`)));
      req.on('error', (e) => {
        this.erro = e;
        this.fechada = true;
        if (!pronto) reject(e);
      });
      req.end();
      this.req = req;
    });
  }

  fechar() {
    this.fechada = true;
    try { this.req && this.req.destroy(); } catch { /* já fechada */ }
  }
}

/**
 * Analisa um bloco SSE (`event:`/`data:`). Devolve null para comentários — o
 * heartbeat `: ping` do produto chega a cada 25 s e não é evento de negócio.
 */
function analisar(bruto) {
  let nome = 'message';
  const dados = [];
  for (const linha of bruto.split('\n')) {
    if (!linha || linha.startsWith(':')) continue;
    const sep = linha.indexOf(':');
    const campo = sep === -1 ? linha : linha.slice(0, sep);
    const valor = sep === -1 ? '' : linha.slice(sep + 1).replace(/^ /, '');
    if (campo === 'event') nome = valor;
    else if (campo === 'data') dados.push(valor);
  }
  if (!dados.length && nome === 'message') return null; // ex.: só `retry:`
  let payload = null;
  try { payload = JSON.parse(dados.join('\n')); } catch { payload = dados.join('\n'); }
  return { nome, payload };
}

module.exports = { ConexaoSse, analisar };
