#!/usr/bin/env node
// scripts/carga/executar.js — CLI do harness de carga (FIL-110).
//
//   node scripts/carga/executar.js <cenário> --base-url <url> [opções]
//
// Cenários: semear · sse · pool · webhook · isolamento · tudo · limpar
//
// ⚠️ ALVO. `semear`/`limpar` falam DIRETO com o banco (DATABASE_URL do
// ambiente, carregada de server/.env) — os cenários falam por HTTP com
// `--base-url`. São dois endereços independentes: apontar a base-url para
// staging com a DATABASE_URL de desenvolvimento semearia um banco e mediria
// outro. O comando `semear` imprime host do banco e alvo HTTP juntos, para
// esse erro aparecer antes do teste.
//
// A guarda contra produção está em alvo.js e não tem flag de escape.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolverAlvo, AlvoRecusado } = require('./alvo');
const { carregarEnv } = require('./ambiente');
const { encerrarAgentes } = require('./http');
const { cenarioSse, tabelaSse } = require('./cenario-sse');
const { cenarioPool, tabelaPool } = require('./cenario-pool');
const { cenarioWebhook, tabelaWebhook, MARCADOR } = require('./cenario-webhook');
const { cenarioIsolamento } = require('./cenario-isolamento');
const semente = require('./semear');

const DIR_RESULTADOS = path.join(__dirname, 'resultados');

function args(argv) {
  const saida = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { saida._.push(a); continue; }
    const chave = a.slice(2);
    const proximo = argv[i + 1];
    if (proximo === undefined || proximo.startsWith('--')) saida[chave] = true;
    else { saida[chave] = proximo; i += 1; }
  }
  return saida;
}

const numeros = (v, padrao) => (typeof v === 'string' ? v.split(',').map(Number).filter(Number.isFinite) : padrao);

function gravar(nome, dados) {
  fs.mkdirSync(DIR_RESULTADOS, { recursive: true });
  const arquivo = path.join(DIR_RESULTADOS, `${nome}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2));
  console.log(`\nResultado bruto: ${arquivo}`);
  return arquivo;
}

function hostDoBanco() {
  const url = process.env.DATABASE_URL || '';
  try { return new URL(url).host; } catch { return '(DATABASE_URL ausente)'; }
}

const USO = `
Harness de carga do Olume Chat (FIL-110)

  node scripts/carga/executar.js <cenário> [opções]

Cenários
  semear       cria tenants/usuários sintéticos no banco de DATABASE_URL
  sse          rampa de conexões SSE simultâneas (o cenário principal)
  pool         concorrência contra o pool do Postgres
  webhook      rajada de webhooks da Meta
  isolamento   um tenant não vê evento nem conversa de outro, sob carga
  tudo         pool → webhook → isolamento → sse, na ordem
  limpar       apaga tudo que o harness criou

Opções
  --base-url <url>       alvo HTTP (ex.: http://localhost:3001)
  --pid <n>              PID do processo alvo para amostrar CPU/RAM
  --degraus 50,100,200   degraus da rampa SSE
  --niveis 5,10,20       concorrências do cenário de pool
  --taxas 10,25,50       req/s do cenário de webhook
  --segundos <n>         duração de cada nível (pool/webhook)
  --sondas <n>           eventos medidos por degrau (sse)
  --tenants <n>          tenants a semear/usar
  --usuarios <n>         usuários por tenant
  --um-tenant            concentra a rampa SSE num tenant só (pior caso do fan-out)
  --token-local          assina as sessões da rampa com JWT_SECRET (contorna o
                         limitador de LOGIN, não a autenticação — ver credencial.js)
  --caminho <rota>       rota do cenário de pool (padrão /health/ready)
  --eu-sei-o-que-estou-fazendo  libera host fora da lista conhecida

Ambiente
  CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET  service token do Cloudflare Access
  CARGA_META_APP_SECRET                          assina o webhook (sem ele, mede a rejeição)
`;

async function principal() {
  const a = args(process.argv.slice(2));
  const cenario = a._[0];
  if (!cenario || a.help) { console.log(USO); return 0; }

  // server/.env alimenta os comandos de banco (DATABASE_URL) e o `--token-local`
  // (JWT_SECRET). Variável já exportada no processo vence o arquivo — é assim
  // que se aponta o harness para outro ambiente sem editar segredo.
  const env = carregarEnv();
  if (['semear', 'limpar'].includes(cenario) && !env.carregado && !process.env.DATABASE_URL) {
    console.error(`Não encontrei ${env.caminho}. Este comando fala direto com o banco e precisa de DATABASE_URL.`);
    return 2;
  }

  if (cenario === 'semear') {
    const alvoHttp = a['base-url'] ? String(a['base-url']) : '(nenhum)';
    console.log(`Semeando em ${hostDoBanco()} — alvo HTTP declarado: ${alvoHttp}`);
    const r = await semente.semear({
      tenants: Number(a.tenants) || 20,
      usuarios: Number(a.usuarios) || 10,
    });
    console.log(`Pronto: ${r.tenants.length} tenants, ${r.tenants.reduce((s, t) => s + t.usuarios.length, 0)} usuários.`);
    return 0;
  }

  if (cenario === 'limpar') {
    console.log(`Limpando ${hostDoBanco()}…`);
    const r = await semente.limpar({});
    console.log(`Tenants removidos: ${r.ids.length}${r.slugs ? ` (${r.slugs.join(', ')})` : ''}`);
    console.log(`Linhas por tabela: ${JSON.stringify(r.tabelas)}`);
    const eventos = await limparWebhook();
    console.log(`Eventos de webhook sintéticos removidos: ${eventos}`);
    return 0;
  }

  const alvo = resolverAlvo(a['base-url'], { forcar: Boolean(a['eu-sei-o-que-estou-fazendo']) });
  console.log(`Alvo: ${alvo.origin}${alvo.pathname}`);
  const pid = a.pid ? Number(a.pid) : null;
  if (!pid) console.log('AVISO: sem --pid, CPU/RAM do alvo não serão medidos (o relatório dirá "não medido").');

  const carregarContas = () => {
    const s = semente.carregarSemente();
    return s.tenants;
  };

  const resultados = {};
  const ordem = cenario === 'tudo' ? ['pool', 'webhook', 'isolamento', 'sse'] : [cenario];

  for (const passo of ordem) {
    if (passo === 'pool') {
      resultados.pool = await cenarioPool(alvo, {
        niveis: numeros(a.niveis, [5, 10, 20, 50, 100, 200]),
        segundos: Number(a.segundos) || 10,
        caminho: a.caminho ? String(a.caminho) : '/health/ready',
        // Com --token-local a rota medida é autenticada de verdade: passa pelo
        // middleware (que consulta a jti-blacklist no banco) antes da consulta
        // da própria rota. É a diferença entre medir o pool e medir o custo
        // real de uma chamada do painel.
        token: a['token-local'] ? tokenDaSemente() : (a.token ? String(a.token) : null),
        pid,
      });
      console.log(`\n${tabelaPool(resultados.pool)}`);
    } else if (passo === 'webhook') {
      resultados.webhook = await cenarioWebhook(alvo, {
        taxas: numeros(a.taxas, [10, 25, 50, 100]),
        segundos: Number(a.segundos) || 10,
        pid,
      });
      console.log(`\n${tabelaWebhook(resultados.webhook)}`);
    } else if (passo === 'isolamento') {
      resultados.isolamento = await cenarioIsolamento(alvo, {
        contas: carregarContas(),
        tenants: Number(a.tenants) || 20,
        tokenLocal: Boolean(a['token-local']),
      });
    } else if (passo === 'sse') {
      resultados.sse = await cenarioSse(alvo, {
        contas: carregarContas(),
        degraus: numeros(a.degraus, [50, 100, 200, 400, 800]),
        sondas: Number(a.sondas) || 5,
        taxaAbertura: Number(a['taxa-abertura']) || 25,
        umTenant: Boolean(a['um-tenant']),
        tokenLocal: Boolean(a['token-local']),
        pid,
      });
      console.log(`\n${tabelaSse(resultados.sse)}`);
    } else {
      console.error(`Cenário desconhecido: ${passo}`);
      console.log(USO);
      return 2;
    }
  }

  gravar(cenario, { alvo: alvo.origin, quando: new Date().toISOString(), pid, resultados });
  encerrarAgentes();
  return 0;
}

/** Token assinado para o primeiro usuário do primeiro tenant semeado. */
function tokenDaSemente() {
  const { assinarToken } = require('./credencial');
  const conta = semente.carregarSemente().tenants[0];
  const u = conta.usuarios[0];
  return assinarToken({ tenantId: conta.tenantId, usuarioId: u.usuarioId, nome: u.nome, email: u.email });
}

/** Apaga os `webhook_evento` sintéticos (marcador no wamid). */
async function limparWebhook() {
  const { comOperador } = require(path.join(__dirname, '..', '..', 'server', 'operador', 'db'));
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `DELETE FROM webhook_evento WHERE chave_idempotente LIKE :m OR payload LIKE :p`,
      { m: `%${MARCADOR}%`, p: `%${MARCADOR}%` }
    );
    return r.rowsAffected;
  });
}

principal()
  .then((codigo) => process.exit(codigo))
  .catch((err) => {
    if (err instanceof AlvoRecusado) console.error(`\n${err.message}`);
    else console.error('\nFALHA:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
