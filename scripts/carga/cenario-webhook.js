// scripts/carga/cenario-webhook.js — Rajada de webhooks da Meta (FIL-110).
//
// ── A assinatura NÃO é contornada ──────────────────────────────────────────
// `POST /webhook` exige HMAC-SHA256 do corpo cru com o `META_APP_SECRET`
// (webhook/routes.js). Se o ambiente alvo tem placeholder no segredo, TODA
// requisição volta 401 — e isso é RESULTADO A REGISTRAR, não obstáculo a
// remover. Afrouxar a validação para "conseguir medir" trocaria o portão que
// impede qualquer um da internet de escrever no inbox dos clientes por um
// número bonito no relatório.
//
// O harness assina quando (e somente quando) o operador informa o segredo em
// `CARGA_META_APP_SECRET`. Sem ele, o cenário roda mesmo assim e mede o que dá
// para medir sem segredo: o custo do caminho de REJEIÇÃO (o que a internet
// consegue fazer o servidor gastar sem credencial nenhuma) — número útil por
// si só, porque é o endpoint público exposto.
//
// ── O que se mede quando há assinatura ─────────────────────────────────────
// Latência do ACK. O contrato do produto (webhook/durabilidade.js) é gravar o
// evento bruto ANTES de responder 200 — então o ACK inclui uma escrita no
// Postgres. A meta do ESCALABILIDADE.md é confirmação abaixo de 250 ms com o
// banco saudável; a rajada mostra em que taxa isso deixa de valer.
//
// ── Efeito colateral ───────────────────────────────────────────────────────
// Cada evento aceito vira uma linha em `webhook_evento`. O `phone_number_id`
// sintético não pertence a nenhum tenant, então o processamento assíncrono
// descarta o evento sem criar contato/conversa — de propósito: a rajada mede a
// ENTRADA DURÁVEL, não o pipeline de conversa. Todo wamid carrega o marcador
// `CARGA-FIL110`, e `executar.js limpar` apaga essas linhas.
'use strict';

const crypto = require('node:crypto');
const { pedir } = require('./http');
const { resumo, ms, tabela } = require('./estatistica');
const { amostra, cpuPercentual } = require('./amostrar');

const MARCADOR = 'CARGA-FIL110';

/** Payload de mensagem de texto no formato da Cloud API. */
function corpoSintetico(n, phoneNumberId) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: `${MARCADOR}-waba`,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '5500000000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Carga sintética' }, wa_id: '5500000000001' }],
          messages: [{
            from: '5500000000001',
            id: `wamid.${MARCADOR}-${process.pid}-${n}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: `carga ${n}` },
          }],
        },
      }],
    }],
  });
}

function assinar(corpo, segredo) {
  return `sha256=${crypto.createHmac('sha256', segredo).update(corpo).digest('hex')}`;
}

async function cenarioWebhook(alvo, opcoes = {}) {
  const taxas = opcoes.taxas || [10, 25, 50, 100];
  const segundos = opcoes.segundos || 10;
  const caminho = opcoes.caminho || '/webhook';
  const segredo = process.env.CARGA_META_APP_SECRET || null;
  const phoneNumberId = opcoes.phoneNumberId || `${MARCADOR}-0000`;
  const pid = opcoes.pid || null;

  const resultado = { assinado: Boolean(segredo), caminho, taxas: [], quebra: null, marcador: MARCADOR };
  if (!segredo) {
    console.log('\n[webhook] SEM CARGA_META_APP_SECRET — medindo apenas o caminho de rejeição (401 esperado).');
  }

  let anterior = await amostra(pid);
  let tAnterior = Date.now();
  let seq = 0;

  for (const taxa of taxas) {
    console.log(`\n[webhook] ${taxa} req/s por ${segundos}s em ${caminho}…`);
    const latencias = [];
    const porStatus = new Map();
    let erros = 0;
    const intervalo = 1000 / taxa;
    const emVoo = [];
    const inicio = Date.now();
    const fim = inicio + segundos * 1000;

    while (Date.now() < fim) {
      const n = seq++;
      const corpo = corpoSintetico(n, phoneNumberId);
      emVoo.push((async () => {
        try {
          const r = await pedir(alvo, caminho, {
            metodo: 'POST',
            corpo,
            cabecalhos: {
              'Content-Type': 'application/json',
              ...(segredo ? { 'x-hub-signature-256': assinar(corpo, segredo) } : {}),
            },
            timeoutMs: 30_000,
          });
          latencias.push(r.ms);
          porStatus.set(r.status, (porStatus.get(r.status) || 0) + 1);
        } catch (err) {
          erros += 1;
          porStatus.set(err.message.slice(0, 40), (porStatus.get(err.message.slice(0, 40)) || 0) + 1);
        }
      })());
      // Ritmo por relógio de parede: `await dormir(intervalo)` acumularia o
      // tempo da própria requisição e a taxa real ficaria abaixo da pedida.
      const proximo = inicio + emVoo.length * intervalo;
      const espera = proximo - Date.now();
      if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    }
    await Promise.all(emVoo);

    const atual = await amostra(pid);
    const agora = Date.now();
    const cpu = cpuPercentual(anterior, atual, agora - tAnterior);
    anterior = atual; tAnterior = agora;

    const lat = resumo(latencias);
    const total = latencias.length + erros;
    const aceitos = porStatus.get(200) || 0;
    const rejeitados = porStatus.get(401) || 0;
    const indisponivel = porStatus.get(503) || 0;
    const taxaReal = total / segundos;

    resultado.taxas.push({
      taxaPedida: taxa, taxaReal, total, aceitos, rejeitados, indisponivel,
      status: Object.fromEntries(porStatus), latencia: lat, cpuPercent: cpu,
    });
    console.log(`[webhook] enviados=${total} (${taxaReal.toFixed(0)}/s) 200=${aceitos} 401=${rejeitados} 503=${indisponivel}` +
      ` p50=${ms(lat.p50)} p95=${ms(lat.p95)} max=${ms(lat.max)}` + (cpu == null ? '' : ` cpu=${cpu.toFixed(0)}%`));

    const criterios = [];
    if (indisponivel) criterios.push(`${indisponivel} respostas 503 (a Meta reenviaria)`);
    if (erros) criterios.push(`${erros} erros de transporte`);
    if (segredo && lat.p95 != null && lat.p95 > 250) criterios.push(`ACK p95 ${ms(lat.p95)} acima da meta de 250 ms`);
    if (criterios.length) {
      resultado.quebra = { taxa, criterios };
      console.log(`\n[webhook] PONTO DE QUEBRA em ${taxa}/s: ${criterios.join('; ')}`);
      break;
    }
  }
  return resultado;
}

function tabelaWebhook(resultado) {
  return tabela(
    ['Taxa pedida', 'Taxa real', 'Enviados', '200', '401', '503', 'p50', 'p95', 'máx', 'CPU'],
    resultado.taxas.map((t) => [
      `${t.taxaPedida}/s`, `${t.taxaReal.toFixed(0)}/s`, String(t.total),
      String(t.aceitos), String(t.rejeitados), String(t.indisponivel),
      ms(t.latencia.p50), ms(t.latencia.p95), ms(t.latencia.max),
      t.cpuPercent == null ? '—' : `${t.cpuPercent.toFixed(0)}%`,
    ])
  );
}

module.exports = { cenarioWebhook, tabelaWebhook, MARCADOR };
