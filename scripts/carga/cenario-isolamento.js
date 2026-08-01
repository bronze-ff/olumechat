// scripts/carga/cenario-isolamento.js — Isolamento entre tenants SOB CARGA (FIL-110).
//
// A suíte já prova o isolamento em repouso (RLS, `test/db-tenant.test.js`, e o
// gate de tenant do api/stream.js). O que ela NÃO cobre é o hub com muitos
// tenants assinando ao mesmo tempo: o `subscribe(fn, tenantId)` é in-process e
// o filtro final é uma comparação em memória (`evt.tenantId !== tenantId`).
// Um vazamento aqui não seria de banco, seria de barramento — e apareceria
// justamente quando há concorrência, não num teste com um assinante.
//
// Método: uma conexão SSE por tenant, todas abertas ao mesmo tempo; publica-se
// um evento em UM tenant por vez (PUT /api/presenca) e observa-se QUEM recebeu.
// Qualquer chegada numa conexão de outro tenant é violação — e o cenário falha
// alto, com o par (tenant que publicou, tenant que recebeu).
//
// Também se confere o lado REST: um usuário do tenant A listando conversas não
// pode ver nada do tenant B. Aqui a asserção é sobre o CONJUNTO de ids
// devolvido, não sobre a contagem — contagem igual a zero passaria por acaso
// num ambiente recém-semeado.
'use strict';

const { pedirJson } = require('./http');
const { ConexaoSse } = require('./sse');
const { entrar } = require('./cenario-sse');
const { assinarToken } = require('./credencial');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function cenarioIsolamento(alvo, opcoes = {}) {
  const contas = (opcoes.contas || []).slice(0, opcoes.tenants || 20);
  if (contas.length < 2) throw new Error('Isolamento exige ao menos 2 tenants semeados.');
  const timeoutMs = opcoes.timeoutMs || 3000;

  const recebidos = new Map(); // slug -> payloads recebidos desde a última sonda
  const abertas = [];
  const sessoes = new Map();
  const idPorSlug = new Map(contas.map((c) => [c.slug, Number(c.tenantId)]));

  for (const conta of contas) {
    const u = conta.usuarios[0];
    // Mesma razão do cenário SSE: o limitador de login (10/15min/IP) não deixa
    // autenticar 20 tenants de uma máquina só. Ver credencial.js.
    const sessao = opcoes.tokenLocal
      ? { token: assinarToken({ tenantId: conta.tenantId, usuarioId: u.usuarioId, nome: u.nome, email: u.email }) }
      : await entrar(alvo, { slug: conta.slug, email: u.email, senha: u.senha });
    sessoes.set(conta.slug, sessao);
    const t = await pedirJson(alvo, '/api/stream/ticket', {
      metodo: 'POST', cabecalhos: { Authorization: `Bearer ${sessao.token}` },
    });
    if (t.status !== 200) throw new Error(`ticket de ${conta.slug}: HTTP ${t.status}`);
    recebidos.set(conta.slug, []);
    const conexao = new ConexaoSse(alvo, t.json.ticket, (evento) => {
      recebidos.get(conta.slug).push(evento.payload);
    });
    await conexao.abrir();
    abertas.push({ slug: conta.slug, conexao });
  }
  console.log(`[isolamento] ${abertas.length} conexões abertas, uma por tenant.`);

  const violacoes = [];
  const semEntrega = [];

  for (const conta of contas) {
    for (const lista of recebidos.values()) lista.length = 0;
    const sessao = sessoes.get(conta.slug);
    const estado = 'pausa';
    const r = await pedirJson(alvo, '/api/presenca', {
      metodo: 'PUT', corpo: { estado },
      cabecalhos: { Authorization: `Bearer ${sessao.token}` },
    });
    if (r.status !== 200) throw new Error(`PUT /api/presenca em ${conta.slug}: HTTP ${r.status}`);
    await dormir(timeoutMs);

    if (!recebidos.get(conta.slug).some((e) => e && e.tipo === 'presenca')) {
      semEntrega.push(conta.slug); // não é vazamento, mas invalidaria a conclusão
    }
    // A violação é decidida pelo `tenantId` DO EVENTO, não por "chegou algo na
    // janela em que eu publiquei". Sob carga há outros publicadores no ar (a
    // própria rampa gera presença), e atribuir por tempo acusaria vazamento
    // onde só houve concorrência — foi o que aconteceu na primeira versão
    // deste cenário. Com o tenantId do payload a asserção é exata: qualquer
    // evento cujo tenant não é o do assinante é vazamento, venha de onde vier.
    for (const [slug, lista] of recebidos) {
      const meu = idPorSlug.get(slug);
      const vazou = lista.filter((e) => e && e.tipo === 'presenca' && Number(e.tenantId) !== Number(meu));
      if (vazou.length) {
        violacoes.push({
          recebeu: slug,
          tenantDoAssinante: meu,
          tenantsVistos: [...new Set(vazou.map((e) => e.tenantId))],
          eventos: vazou.length,
        });
      }
    }
    // Volta ao estado original para não deixar o tenant pausado.
    await pedirJson(alvo, '/api/presenca', {
      metodo: 'PUT', corpo: { estado: 'online' },
      cabecalhos: { Authorization: `Bearer ${sessao.token}` },
    });
    await dormir(150);
  }

  // ── Lado REST ────────────────────────────────────────────────────────────
  // A semente deixou UMA conversa de id conhecido em cada tenant. A asserção é
  // dupla e proposital: cada tenant tem de ver a PRÓPRIA (senão a listagem está
  // vazia por outro motivo e o "não vazou" não significaria nada) e não pode
  // ver a de nenhum outro.
  const cruzamentos = [];
  const semProprias = [];
  const conhecidas = new Map(contas.filter((c) => c.conversaId).map((c) => [c.conversaId, c.slug]));
  for (const conta of contas) {
    if (!conta.conversaId) continue;
    const r = await pedirJson(alvo, '/api/conversas?status=aberta', {
      cabecalhos: { Authorization: `Bearer ${sessoes.get(conta.slug).token}` },
    });
    const linhas = Array.isArray(r.json) ? r.json : (r.json && (r.json.itens || r.json.conversas)) || [];
    const vistos = new Set(linhas.map((c) => Number(c.id ?? c.ID)).filter(Number.isFinite));
    if (!vistos.has(conta.conversaId)) semProprias.push({ slug: conta.slug, status: r.status });
    for (const id of vistos) {
      const dono = conhecidas.get(id);
      if (dono && dono !== conta.slug) cruzamentos.push({ viu: conta.slug, dadoDe: dono, conversaId: id });
    }
  }

  for (const c of abertas) c.conexao.fechar();

  const ok = violacoes.length === 0 && cruzamentos.length === 0;
  const conclusivo = semEntrega.length === 0 && semProprias.length === 0;
  console.log(`[isolamento] ${ok ? 'OK' : 'VIOLAÇÃO'} — SSE: ${violacoes.length} vazamentos;` +
    ` REST: ${cruzamentos.length} conversas de outro tenant visíveis.` +
    (conclusivo ? '' : ` ATENÇÃO: resultado NÃO conclusivo — sem entrega própria em ${semEntrega.length} tenants` +
      ` e sem a própria conversa em ${semProprias.length}.`));

  return { ok, conclusivo, tenants: contas.length, violacoes, cruzamentos, semEntrega, semProprias };
}

module.exports = { cenarioIsolamento };
