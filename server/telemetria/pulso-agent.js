'use strict';
// pulso-agent — cliente de telemetria/licença embutido em cada app.
// "Liga pra casa" (heartbeat) a cada ~60s reportando identidade, versão, usuários
// online e contadores de uso. Autocontido (só built-ins do Node + fetch).
//
// NUNCA derruba o app: sem config → só avisa e fica inerte; erro de rede → ignora
// (devolve os contadores pro próximo envio). Visibilidade-first, sem bloquear.
//
// Uso no boot do app:
//   const pulso = require('pulso-agent');
//   const agente = pulso.iniciar({
//     app: 'mc-despesas',
//     versao: require('fs').readFileSync('installer/VERSION','utf8').trim(),
//     online: () => contarUsuariosOnline(),   // getter por app (presença / last-seen)
//   });
//   // ... ao longo do app:  agente.contar('despesa_aprovada');

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let cfg = null;
let timer = null;
let onlineGetter = () => 0;
let counters = {};

function lerEnv() {
  return {
    url: (process.env.PULSO_URL || '').replace(/\/+$/, ''),
    key: process.env.PULSO_KEY || '',
    secret: process.env.PULSO_SECRET || '',
    anon: process.env.PULSO_ANON_KEY || '', // passa pelo "Verify JWT" do Supabase (chave pública)
    dataDir: process.env.PULSO_DATA_DIR || process.cwd(),
    intervaloMs: Number(process.env.PULSO_INTERVALO_MS) || 60_000,
  };
}

// UUID estável da instância: gerado no 1º boot e persistido em arquivo. Se o app
// for copiado p/ outra máquina junto com o arquivo, o mesmo UUID reaparece de outro
// hostname/MAC → o Pulso flaga (id_duplicado). Se copiarem sem o arquivo, vira uma
// instância "nova" → também aparece no painel. Os dois caminhos geram evidência.
function instanceUuid(dataDir) {
  const f = path.join(dataDir, '.pulso-instance.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && j.instanceUuid) return j.instanceUuid;
  } catch { /* gera abaixo */ }
  const id = crypto.randomUUID();
  try { fs.writeFileSync(f, JSON.stringify({ instanceUuid: id, criado: new Date().toISOString() }, null, 2)); }
  catch (e) { console.warn('[pulso] não consegui persistir o instanceUuid:', e.message); }
  return id;
}

function macPrimario() {
  const ifs = os.networkInterfaces();
  for (const nome of Object.keys(ifs)) {
    for (const ni of ifs[nome] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return null;
}

function fingerprint() {
  const conn = process.env.ORACLE_CONNECT_STRING || '';
  return {
    hostname: os.hostname(),
    mac: macPrimario(),
    connHash: conn ? crypto.createHash('sha256').update(conn).digest('hex').slice(0, 16) : null,
  };
}

const assinar = (secret, ts, body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
const mesclar = (a, b) => { const o = { ...a }; for (const k in b) o[k] = (o[k] || 0) + b[k]; return o; };

/** Incrementa um contador de uso (zerado a cada heartbeat enviado). */
function contar(evento, n = 1) {
  if (!evento) return;
  counters[evento] = (counters[evento] || 0) + (Number(n) || 0);
}

async function enviarHeartbeat() {
  const ts = new Date().toISOString();
  let online = 0;
  try { online = Number(onlineGetter()) || 0; } catch { /* getter do app falhou; segue com 0 */ }
  const usados = counters; counters = {}; // flush
  const body = JSON.stringify({
    app: cfg.app, version: cfg.versao, instanceUuid: cfg.instanceUuid,
    fingerprint: cfg.fingerprint, onlineUsers: online, counters: usados,
  });
  try {
    const resp = await fetch(`${cfg.url}/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.anon ? { apikey: cfg.anon, authorization: `Bearer ${cfg.anon}` } : {}),
        'x-pulso-key': cfg.key,
        'x-pulso-ts': ts,
        'x-pulso-sign': assinar(cfg.secret, ts, body),
      },
      body,
    });
    if (!resp.ok) console.warn(`[pulso] heartbeat HTTP ${resp.status}`);
  } catch (e) {
    counters = mesclar(counters, usados); // rede ruim: não perde os contadores
    console.warn('[pulso] heartbeat falhou (rede?):', e.message);
  }
}

async function activate() {
  try {
    const resp = await fetch(`${cfg.url}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.anon ? { apikey: cfg.anon, authorization: `Bearer ${cfg.anon}` } : {}) },
      body: JSON.stringify({ app: cfg.app, chave: cfg.key }),
    });
    const j = await resp.json().catch(() => ({}));
    if (j.known) console.log(`[pulso] licença ${j.status} — ${j.empresa || '?'} / ${j.app || cfg.app}`);
    else console.warn('[pulso] licença DESCONHECIDA — esta instância vai aparecer flagada no painel.');
  } catch { /* silencioso: activate é só informativo */ }
}

/**
 * Liga o agente. Devolve { contar, parar }. Sem PULSO_URL/KEY/SECRET → no-op (não derruba o app).
 * @param {{app:string, versao?:string, online?:()=>number}} opts
 */
function iniciar(opts = {}) {
  const env = lerEnv();
  if (!env.url || !env.key || !env.secret) {
    console.warn('[pulso] PULSO_URL/PULSO_KEY/PULSO_SECRET ausentes — telemetria desligada (app segue normal).');
    return { contar: () => {}, parar: () => {} };
  }
  if (!opts.app) { console.warn('[pulso] opts.app é obrigatório — telemetria desligada.'); return { contar: () => {}, parar: () => {} }; }

  cfg = {
    app: opts.app,
    versao: String(opts.versao || ''),
    url: env.url, key: env.key, secret: env.secret, anon: env.anon,
    instanceUuid: instanceUuid(env.dataDir),
    fingerprint: fingerprint(),
  };
  if (typeof opts.online === 'function') onlineGetter = opts.online;

  activate();
  enviarHeartbeat();
  timer = setInterval(enviarHeartbeat, env.intervaloMs);
  if (timer.unref) timer.unref(); // não segura o processo
  return { contar, parar: () => { if (timer) clearInterval(timer); } };
}

module.exports = { iniciar, contar };
