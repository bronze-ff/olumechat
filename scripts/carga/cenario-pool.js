// scripts/carga/cenario-pool.js — Pool do Postgres sob concorrência (FIL-110).
//
// Alvo padrão: `GET /health/ready`. A escolha é deliberada — o readiness pega
// UMA conexão do pool, roda `SELECT 1` e devolve (app.js). É o menor caminho
// possível que ainda atravessa o pool, então o que aparecer aqui é fila de
// pool, não custo de consulta.
//
// O que se procura: o joelho. Com `DB_POOL_MAX` conexões (padrão 10 em
// db/pool.js), C requisições simultâneas acima disso enfileiram — a latência
// deve crescer proporcional a C/POOL_MAX enquanto a vazão fica estável. Quando
// a espera passa de `connectionTimeoutMillis` (30 s), o `getConnection()`
// estoura e o readiness passa a responder 503: é o ponto de quebra do pool, e
// em produção significa a instância saindo de rotação por fila de banco.
//
// A regra de ouro do repo (AGENTS.md §5 — nunca duas conexões do pool na mesma
// requisição) é o que torna esse cálculo previsível: com uma conexão por
// requisição, C > POOL_MAX é fila; com duas, C > POOL_MAX/2 pode ser DEADLOCK,
// e o sintoma seria timeout mesmo com o banco ocioso. Rodar este cenário contra
// uma rota que segure duas conexões é como o deadlock apareceria.
'use strict';

const { pedirJson, explicarAcesso } = require('./http');
const { resumo, ms, tabela } = require('./estatistica');
const { amostra, cpuPercentual } = require('./amostrar');

async function cenarioPool(alvo, opcoes = {}) {
  const niveis = opcoes.niveis || [5, 10, 20, 50, 100, 200];
  const segundos = opcoes.segundos || 10;
  const caminho = opcoes.caminho || '/health/ready';
  const token = opcoes.token || null;
  const pid = opcoes.pid || null;

  const cabecalhos = token ? { Authorization: `Bearer ${token}` } : {};
  const resultado = { caminho, niveis: [], quebra: null };

  // Sonda inicial: 302/403 do Access aqui vira relatório sobre o Cloudflare.
  const sonda = await pedirJson(alvo, caminho, { cabecalhos });
  const acesso = explicarAcesso(sonda);
  if (acesso) throw new Error(`${caminho}: ${acesso}`);

  let anterior = await amostra(pid);
  let tAnterior = Date.now();

  for (const concorrencia of niveis) {
    console.log(`\n[pool] ${concorrencia} requisições simultâneas por ${segundos}s em ${caminho}…`);
    const latencias = [];
    const porStatus = new Map();
    let erros = 0;
    const fim = Date.now() + segundos * 1000;

    // JANELA REAL, não a configurada. Os trabalhadores largam todos juntos e a
    // última requisição de cada um só termina depois do `fim` — a 1.200
    // simultâneas isso é p50 de 7 s de transbordo sobre 12 s de janela. Dividir
    // por `segundos` inflava a vazão justamente nos níveis enfileirados, que são
    // os que produziram os limites do relatório. Aqui a vazão é
    // `conclusões ÷ (última conclusão − primeiro início)`.
    let inicioReal = null;
    let fimReal = null;
    const marcar = (t0, t1) => {
      if (inicioReal === null || t0 < inicioReal) inicioReal = t0;
      if (fimReal === null || t1 > fimReal) fimReal = t1;
    };

    const trabalhador = async () => {
      while (Date.now() < fim) {
        const t0 = Date.now();
        try {
          const r = await pedirJson(alvo, caminho, { cabecalhos, timeoutMs: 60_000 });
          marcar(t0, Date.now());
          latencias.push(r.ms);
          porStatus.set(r.status, (porStatus.get(r.status) || 0) + 1);
        } catch (err) {
          marcar(t0, Date.now());
          erros += 1;
          porStatus.set(err.message.slice(0, 40), (porStatus.get(err.message.slice(0, 40)) || 0) + 1);
        }
      }
    };
    await Promise.all(Array.from({ length: concorrencia }, trabalhador));
    const janelaMs = inicioReal === null ? segundos * 1000 : Math.max(1, fimReal - inicioReal);

    const atual = await amostra(pid);
    const agora = Date.now();
    const cpu = cpuPercentual(anterior, atual, agora - tAnterior);
    anterior = atual; tAnterior = agora;

    const lat = resumo(latencias);
    const ok = porStatus.get(200) || 0;
    const total = latencias.length + erros;
    const vazao = total / (janelaMs / 1000);
    const naoOk = total - ok;

    const linha = {
      concorrencia,
      total,
      vazao,
      janelaMs,
      segundosPedidos: segundos,
      ok,
      naoOk,
      status: Object.fromEntries(porStatus),
      latencia: lat,
      cpuPercent: cpu,
    };
    resultado.niveis.push(linha);
    console.log(`[pool] req=${total} (${vazao.toFixed(0)}/s em ${(janelaMs / 1000).toFixed(1)}s reais)` +
      ` ok=${ok} nao-ok=${naoOk}` +
      ` p50=${ms(lat.p50)} p95=${ms(lat.p95)} p99=${ms(lat.p99)} max=${ms(lat.max)}` +
      (cpu == null ? '' : ` cpu=${cpu.toFixed(0)}%`));

    const criterios = [];
    if (total && naoOk / total > 0.01) criterios.push(`${((naoOk / total) * 100).toFixed(1)}% de respostas não-200 (${JSON.stringify(linha.status)})`);
    if (lat.p95 != null && lat.p95 > 5000) criterios.push(`p95 ${ms(lat.p95)}`);
    if (criterios.length) {
      resultado.quebra = { concorrencia, criterios };
      console.log(`\n[pool] PONTO DE QUEBRA em ${concorrencia} simultâneas: ${criterios.join('; ')}`);
      break;
    }
  }
  return resultado;
}

function tabelaPool(resultado) {
  return tabela(
    ['Simultâneas', 'Requisições', 'Janela real', 'Vazão', 'Não-200', 'p50', 'p95', 'p99', 'máx', 'CPU'],
    resultado.niveis.map((n) => [
      String(n.concorrencia),
      String(n.total),
      `${(n.janelaMs / 1000).toFixed(1)} s`,
      `${n.vazao.toFixed(0)}/s`,
      String(n.naoOk),
      ms(n.latencia.p50), ms(n.latencia.p95), ms(n.latencia.p99), ms(n.latencia.max),
      n.cpuPercent == null ? '—' : `${n.cpuPercent.toFixed(0)}%`,
    ])
  );
}

module.exports = { cenarioPool, tabelaPool };
