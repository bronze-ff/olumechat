// scripts/carga/cenario-sse.js — Rampa de conexões SSE simultâneas (FIL-110).
//
// É o cenário mais importante do §12 do DEPLOY_VPS: o hub é in-process
// (realtime/hub.js) e cada atendente com o inbox aberto é uma conexão viva.
//
// O que a rampa mede, degrau a degrau (cumulativo — as conexões dos degraus
// anteriores continuam abertas, como no mundo real):
//
//   1. ACEITAÇÃO — quantas conexões o servidor aceita e quantas falham, com o
//      motivo. Cada abertura paga POST /api/stream/ticket + carregarPerfil()
//      (consulta ao banco), então este número também estressa o pool.
//   2. ENTREGA — latência ponta a ponta de um evento real: PUT /api/presenca
//      publica um evento `presenca` que o produto entrega a TODAS as conexões
//      do mesmo tenant. Mede-se do instante em que o PUT sai até o evento
//      chegar em cada conexão. Não há timestamp do servidor no caminho: o
//      harness não instrumenta o produto.
//   3. CUSTO — RSS e CPU do processo alvo (só quando `--pid` é informado).
//
// ── Onde a medição para ────────────────────────────────────────────────────
// O objetivo do ticket é achar ONDE QUEBRA, então a rampa não para no primeiro
// número feio: ela registra e continua até um dos critérios duros abaixo, e o
// degrau que os cruzou vira o ponto de quebra do relatório.
//
//   • mais de 5% das conexões do degrau recusadas/erradas;
//   • p95 de entrega acima de 2.000 ms (limite de "tempo real" na prática);
//   • mais de 1% dos eventos publicados não chegando em 5 s.
//
// ── Fan-out por tenant, não global ─────────────────────────────────────────
// O hub filtra por tenant (canal LISTEN/NOTIFY dedicado), então o custo de um
// evento é proporcional às conexões DAQUELE tenant, não ao total. Por isso o
// relatório registra o fan-out efetivo de cada sonda: 200 conexões espalhadas
// em 20 tenants não medem o mesmo que 200 conexões de um cliente só. Use
// `--um-tenant` para o pior caso (um cliente grande com toda a equipe aberta).
'use strict';

const { pedirJson, explicarAcesso } = require('./http');
const { ConexaoSse } = require('./sse');
const { resumo, ms, mb, tabela } = require('./estatistica');
const { amostra, cpuPercentual } = require('./amostrar');
const { assinarToken } = require('./credencial');

const dormir = (msTempo) => new Promise((r) => setTimeout(r, msTempo));

/** Login real (argon2id no servidor). Devolve { token, tenantSlug, email, ms }. */
async function entrar(alvo, { slug, email, senha }) {
  const r = await pedirJson(alvo, '/api/auth/login', {
    metodo: 'POST',
    corpo: { empresa: slug, email, senha },
  });
  if (r.status !== 200 || !r.json || !r.json.token) {
    const acesso = explicarAcesso(r);
    throw new Error(acesso || `login falhou (${r.status}): ${r.corpo.slice(0, 200)}`);
  }
  return { token: r.json.token, slug, email, ms: r.ms };
}

/** Executa `tarefas` com no máximo `limite` em voo. Preserva a ordem do retorno. */
async function comLimite(tarefas, limite) {
  const saida = new Array(tarefas.length);
  let proxima = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, tarefas.length) }, async () => {
    while (proxima < tarefas.length) {
      const i = proxima++;
      try { saida[i] = { ok: true, valor: await tarefas[i]() }; }
      catch (err) { saida[i] = { ok: false, erro: err }; }
    }
  });
  await Promise.all(trabalhadores);
  return saida;
}

/**
 * @param {URL} alvo
 * @param {object} opcoes
 * @param {Array<{slug:string, usuarios:Array<{email:string,senha:string}>}>} opcoes.contas
 */
async function cenarioSse(alvo, opcoes = {}) {
  const degraus = opcoes.degraus || [50, 100, 200, 400, 800];
  const taxaAbertura = opcoes.taxaAbertura || 25;   // conexões por segundo
  const sondas = opcoes.sondas || 5;                // eventos medidos por degrau
  const timeoutEventoMs = opcoes.timeoutEventoMs || 5_000;
  const pid = opcoes.pid || null;
  const umTenant = Boolean(opcoes.umTenant);

  const contas = umTenant ? opcoes.contas.slice(0, 1) : opcoes.contas;
  if (!contas.length) throw new Error('Nenhuma conta semeada disponível.');

  // ── Fase 1: sessões ───────────────────────────────────────────────────────
  // O login real é limitado a 10 por 15 min por IP (auth/routes.js), então a
  // rampa mede o CUSTO do login numa amostra dentro desse teto e obtém as
  // demais sessões assinando o mesmo JWT (credencial.js explica por quê).
  // Sem `--token-local`, a rampa fica limitada ao que o limitador permitir — e
  // isso também é um resultado.
  const alvoUsuarios = [];
  for (const conta of contas) {
    for (const u of conta.usuarios) alvoUsuarios.push({ slug: conta.slug, tenantId: conta.tenantId, ...u });
  }
  // `--deslocamento` escolhe OUTRA janela de identidades. Sem ele, execuções
  // seguidas pegam os mesmos usuários, e o cache de perfil (TTL de 30 s) ainda
  // estaria quente da execução anterior — o segundo número sairia melhor que o
  // primeiro só por isso. Comparar taxas de abertura exige cada execução
  // começar fria.
  const deslocamento = Math.max(0, Number(opcoes.deslocamento) || 0);
  const maiorDegrau = Math.max(...degraus);
  const disponiveis = alvoUsuarios.slice(deslocamento);
  const precisos = disponiveis.slice(0, Math.min(disponiveis.length, maiorDegrau));
  const amostraLogin = precisos.slice(0, opcoes.amostraLogin || 8);

  console.log(`\n[sse] medindo login real em ${amostraLogin.length} usuários (teto do limitador: 10/15min/IP)…`);
  const logins = await comLimite(amostraLogin.map((u) => () => entrar(alvo, u)), opcoes.concorrenciaLogin || 4);
  const okLogin = logins.filter((r) => r.ok).map((r) => r.valor);
  const loginsFalhos = logins.filter((r) => !r.ok);
  const msLogin = resumo(okLogin.map((s) => s.ms));
  console.log(`[sse] login ok=${okLogin.length} falho=${loginsFalhos.length}` +
    ` p50=${ms(msLogin.p50)} p95=${ms(msLogin.p95)} max=${ms(msLogin.max)}` +
    (loginsFalhos.length ? ` | 1º erro: ${loginsFalhos[0].erro.message.slice(0, 80)}` : ''));

  let sessoes;
  if (opcoes.tokenLocal) {
    sessoes = precisos.map((u) => ({
      token: assinarToken({ tenantId: u.tenantId, usuarioId: u.usuarioId, nome: u.nome, email: u.email }),
      slug: u.slug,
      email: u.email,
    }));
    console.log(`[sse] ${sessoes.length} sessões assinadas localmente (JWT_SECRET do ambiente).`);
  } else {
    sessoes = okLogin;
    console.log(`[sse] sem --token-local: a rampa usará ${sessoes.length} sessões, repetidas entre as conexões.`);
  }
  if (!sessoes.length) throw new Error(`nenhuma sessão disponível: ${loginsFalhos[0]?.erro?.message || 'sem login'}`);

  // ── Identidades distintas: exigência, não detalhe ────────────────────────
  // `carregarPerfil()` tem cache por (tenant, matrícula) com TTL de 30 s. Se a
  // rampa reusar identidade — 6.400 conexões sobre 200 usuários —, quase toda
  // abertura PULA a consulta de perfil, e a taxa medida vira a de uma
  // reconexão com cache quente. Um restart real tem milhares de atendentes
  // distintos, todos frios: é o caso que o número precisa representar.
  //
  // Por isso falta de usuário é ERRO, com a conta do que falta, e não um
  // silencioso `% sessoes.length`. `--reusar-identidades` existe para o
  // cenário de fan-out (`--um-tenant`), onde o que se mede é entrega e não
  // abertura — e marca o resultado como contaminado, para o relatório não
  // usar o número por engano.
  const identidadesReusadas = Boolean(opcoes.reusarIdentidades);
  if (sessoes.length < maiorDegrau && !identidadesReusadas) {
    throw new Error(
      `Identidades insuficientes: o maior degrau pede ${maiorDegrau} conexões e há ${sessoes.length} usuários ` +
      `em ${contas.length} tenants. Faltam ${maiorDegrau - sessoes.length}.\n` +
      `Semeie mais: node scripts/carga/executar.js semear --tenants ${contas.length} ` +
      `--usuarios ${Math.ceil(maiorDegrau / contas.length)}\n` +
      'Reusar identidade esquentaria o cache de perfil e mediria uma abertura mais barata que a real ' +
      '(use --reusar-identidades só quando a medição for de ENTREGA, não de abertura).'
    );
  }
  if (identidadesReusadas && sessoes.length < maiorDegrau) {
    console.log(`[sse] AVISO: ${maiorDegrau} conexões sobre ${sessoes.length} identidades — cache de perfil quente. ` +
      'Os tempos de CONEXÃO deste resultado não representam reconexão real.');
  }

  // ── Fase 2: rampa ─────────────────────────────────────────────────────────
  const conexoes = [];               // { conexao, slug, sessao }
  const chegadas = new Map();        // chave da sonda -> [{ slug, tEvento }]
  const resultado = {
    degraus: [],
    login: msLogin,
    loginsFalhos: loginsFalhos.length,
    quebra: null,
    contas: contas.length,
    identidades: sessoes.length,
    // Fica no JSON do resultado: um número de ABERTURA colhido com cache de
    // perfil quente não pode virar linha de relatório sem esse aviso junto.
    identidadesReusadas: identidadesReusadas && sessoes.length < maiorDegrau,
  };

  let anterior = await amostra(pid);
  let tAnterior = Date.now();

  for (const degrau of degraus) {
    const aAbrir = degrau - conexoes.length;
    if (aAbrir <= 0) continue;
    console.log(`\n[sse] degrau ${degrau} (+${aAbrir} conexões, ${taxaAbertura}/s)…`);

    const erros = [];
    const prontas = [];
    const intervalo = 1000 / taxaAbertura;
    const emVoo = [];

    for (let i = 0; i < aAbrir; i += 1) {
      // O `%` só entra em ação no modo `--reusar-identidades`; fora dele a
      // guarda acima garante identidades suficientes e cada conexão tem a sua.
      const sessao = sessoes[(conexoes.length + i) % sessoes.length];
      emVoo.push((async () => {
        try {
          const t = await pedirJson(alvo, '/api/stream/ticket', {
            metodo: 'POST', cabecalhos: { Authorization: `Bearer ${sessao.token}` },
          });
          if (t.status !== 200 || !t.json?.ticket) {
            throw new Error(`ticket ${t.status}: ${t.corpo.slice(0, 120)}`);
          }
          // O coletor é registrado por (tenant, estado): o `atendenteId` do
          // publicador só é conhecido depois da resposta do PUT, e o evento
          // pode chegar ANTES dela — o produto publica antes de responder.
          const conexao = new ConexaoSse(alvo, t.json.ticket, (evento, recebidoEm) => {
            if (evento.payload && evento.payload.tipo === 'presenca') {
              const lista = chegadas.get(`${sessao.slug}:${evento.payload.estado}`);
              if (lista) lista.push({ slug: sessao.slug, t: recebidoEm });
            }
          });
          await conexao.abrir();
          conexoes.push({ conexao, slug: sessao.slug, sessao });
          prontas.push(conexao.msAteReady);
        } catch (err) {
          erros.push(err.status ? `HTTP ${err.status}` : err.message);
        }
      })());
      await dormir(intervalo);
    }
    await Promise.all(emVoo);

    // Espera o servidor estabilizar antes de medir entrega. Configurável porque
    // a própria abertura das conexões gera evento de presença (presence.js
    // publica em `conectar`): num tenant grande, a rampa deixa um backlog de
    // eventos para trás, e medir dentro dele mede a fila, não a entrega.
    await dormir(opcoes.esperaEstabilizar || 1500);

    // ── Sondas de entrega ───────────────────────────────────────────────────
    const entregas = [];
    const sondasFalhas = [];
    let perdidos = 0;
    let fanOutTotal = 0;
    let sondasFeitas = 0;
    // Sonda só em tenant que TEM conexão aberta. Escolher por `contas[s %
    // contas.length]` pulava a sonda sempre que a janela de identidades não
    // cobria os primeiros tenants (`--deslocamento`), e o degrau saía com
    // "entrega —" sem explicar por quê — uma lacuna silenciosa exatamente na
    // métrica principal.
    //
    // Só conexões VIVAS entram na conta do fan-out. Uma conexão que o servidor
    // encerrou continua no array `conexoes`, e contá-la como destinatária
    // transformaria "o servidor derrubou N conexões" em "N eventos se
    // perderam" — diagnóstico errado, e no degrau errado. Conexão morta é
    // achado próprio e sai em `conexoesMortas`.
    const vivas = conexoes.filter((c) => !c.conexao.fechada);
    const mortas = conexoes.length - vivas.length;
    const comConexao = [...new Set(vivas.map((c) => c.slug))];
    for (let s = 0; s < sondas && comConexao.length; s += 1) {
      const slugSonda = comConexao[s % comConexao.length];
      const conta = contas.find((c) => c.slug === slugSonda);
      const alvoSonda = vivas.find((c) => c.slug === slugSonda);
      if (!conta || !alvoSonda) continue;
      const esperados = vivas.filter((c) => c.slug === conta.slug).length;
      fanOutTotal += esperados;
      sondasFeitas += 1;

      const estado = s % 2 === 0 ? 'pausa' : 'online';
      const chave = `${conta.slug}:${estado}`;
      const coletor = [];
      chegadas.set(chave, coletor);

      const t0 = process.hrtime.bigint();
      const r = await pedirJson(alvo, '/api/presenca', {
        metodo: 'PUT',
        corpo: { estado },
        cabecalhos: { Authorization: `Bearer ${alvoSonda.sessao.token}` },
      });
      // GATILHO que falha ≠ evento perdido. Contabilizar os dois como "não
      // chegou" acusaria o hub por uma falha do publicador — e o critério de
      // quebra por perda dispararia pelo motivo errado.
      if (r.status !== 200) {
        sondasFalhas.push(`PUT /api/presenca → HTTP ${r.status}: ${String(r.corpo).slice(0, 120)}`);
        fanOutTotal -= esperados;
        sondasFeitas -= 1;
        chegadas.delete(chave);
        continue;
      }

      const limite = Date.now() + timeoutEventoMs;
      while (coletor.length < esperados && Date.now() < limite) await dormir(25);
      for (const c of coletor) entregas.push(Number(c.t - t0) / 1e6);
      perdidos += Math.max(0, esperados - coletor.length);
      chegadas.delete(chave);
      await dormir(200);
    }

    const atual = await amostra(pid);
    const agora = Date.now();
    const cpu = cpuPercentual(anterior, atual, agora - tAnterior);
    anterior = atual; tAnterior = agora;

    const entregaResumo = resumo(entregas);
    const conectarResumo = resumo(prontas);
    const totalEsperado = fanOutTotal;
    const taxaErro = aAbrir ? erros.length / aAbrir : 0;
    const taxaPerda = totalEsperado ? perdidos / totalEsperado : 0;

    const linha = {
      degrau,
      abertas: conexoes.length,
      tentadas: aAbrir,
      falhas: erros.length,
      motivos: [...new Set(erros)].slice(0, 3),
      conectar: conectarResumo,
      entrega: entregaResumo,
      // Média sobre as sondas EXECUTADAS: um tenant sem conexão neste degrau é
      // pulado, e dividir pelas sondas pedidas diluiria o fan-out real.
      fanOutMedio: Math.round(fanOutTotal / Math.max(1, sondasFeitas)),
      sondasFeitas,
      sondasFalhas,
      conexoesMortas: mortas,
      eventosEsperados: totalEsperado,
      eventosPerdidos: perdidos,
      rssBytes: atual ? atual.rssBytes : null,
      cpuPercent: cpu,
    };
    resultado.degraus.push(linha);

    if (mortas) {
      console.log(`[sse] ATENÇÃO: ${mortas} conexões já não estão abertas — o servidor as encerrou.`);
    }
    console.log(`[sse] abertas=${conexoes.length - mortas} falhas=${erros.length}` +
      ` conectar p95=${ms(conectarResumo.p95)} entrega p50=${ms(entregaResumo.p50)}` +
      ` p95=${ms(entregaResumo.p95)} perdidos=${perdidos}/${totalEsperado}` +
      (atual ? ` rss=${mb(atual.rssBytes)} cpu=${cpu == null ? '—' : cpu.toFixed(0) + '%'}` : ''));
    if (erros.length) console.log(`[sse] motivos: ${linha.motivos.join(' | ')}`);
    if (sondasFalhas.length) {
      console.log(`[sse] ATENÇÃO: ${sondasFalhas.length} de ${sondas} sondas não publicaram ` +
        `(não é perda de evento): ${sondasFalhas[0]}`);
    }
    if (!sondasFeitas) {
      console.log('[sse] ATENÇÃO: nenhuma sonda de entrega concluiu neste degrau — ' +
        'a latência de entrega deste degrau é DESCONHECIDA, não "boa".');
    }

    const criterios = [];
    if (taxaErro > 0.05) criterios.push(`${(taxaErro * 100).toFixed(1)}% das conexões falharam`);
    if (entregaResumo.p95 != null && entregaResumo.p95 > 2000) criterios.push(`p95 de entrega ${ms(entregaResumo.p95)}`);
    if (taxaPerda > 0.01) criterios.push(`${(taxaPerda * 100).toFixed(1)}% dos eventos não chegaram em ${timeoutEventoMs} ms`);
    if (criterios.length) {
      resultado.quebra = { degrau, conexoesAbertas: conexoes.length, criterios };
      console.log(`\n[sse] PONTO DE QUEBRA em ${degrau} conexões: ${criterios.join('; ')}`);
      break;
    }
  }

  // ── Encerramento ──────────────────────────────────────────────────────────
  for (const c of conexoes) c.conexao.fechar();
  await dormir(500);
  resultado.rssFinal = await amostra(pid);
  return resultado;
}

/** Tabela markdown do resultado, pronta para o relatório. */
function tabelaSse(resultado) {
  return tabela(
    ['Conexões', 'Falhas', 'Conectar p50', 'Conectar p95', 'Fan-out', 'Entrega p50', 'Entrega p95', 'Entrega máx', 'Perdidos', 'RSS', 'CPU'],
    resultado.degraus.map((d) => [
      String(d.abertas),
      `${d.falhas}/${d.tentadas}`,
      ms(d.conectar.p50), ms(d.conectar.p95),
      String(d.fanOutMedio),
      ms(d.entrega.p50), ms(d.entrega.p95), ms(d.entrega.max),
      `${d.eventosPerdidos}/${d.eventosEsperados}`,
      d.rssBytes == null ? '—' : mb(d.rssBytes),
      d.cpuPercent == null ? '—' : `${d.cpuPercent.toFixed(0)}%`,
    ])
  );
}

module.exports = { cenarioSse, tabelaSse, entrar, comLimite };
