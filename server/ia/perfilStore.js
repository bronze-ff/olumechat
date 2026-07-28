// server/ia/perfilStore.js — perfil de IA de UMA empresa (instruções + ficha +
// blocos de conhecimento) e a montagem do system prompt em camadas (FIL-83).
//
// Substitui o prompt em disco (CONHECIMENTO_DIR/system-prompt.md) que
// ia/runtime.js lia a cada mensagem: era global para o processo inteiro e, como
// a pasta não existe no repositório, TODA empresa rodava com o fallback
// embutido da Multicanal.
//
// ⚠️ RECEBE `conn` — ao contrário de ia/iaConfigStore.js, que NÃO recebe porque
// precisa de comOperador() para chegar na credencial global (tabela fechada
// para o caminho de tenant). Aqui o conteúdo é 100% do tenant e é lido pela
// própria conexão de tenant do chamador, dentro da transação que ele já tem
// aberta (fase 3 do ia/runtime.js). Isso é o que impede uma requisição de
// segurar DUAS conexões do pool ao mesmo tempo — o motivo de o runtime estar
// dividido em três fases (ver o cabeçalho de ia/runtime.js).
//
// Cache Map com TTL 60s por tenant, mesmo padrão do iaConfigStore (um cache
// global vazaria o perfil de uma empresa para outra). Toda escrita pela API
// chama invalidar(tenantId).
'use strict';

const db = require('../db/pool');

const TTL_MS = 60_000;
const cache = new Map(); // tenantId (string) -> { valor, exp }

/** Limites de tamanho — dão erro claro na API em vez de estourar no provedor.
 *  `fichaCampo` não vem do ticket: é teto defensivo para um jsonb livre não
 *  virar caminho de inflar o prompt (e o custo) sem limite nenhum. */
const LIMITES = Object.freeze({
  instrucoes: 8000,
  blocoTitulo: 120,
  blocoConteudo: 20_000,
  blocos: 50,
  fichaCampo: 1000,
});

/** Chaves conhecidas da ficha. O schema guarda jsonb livre (ver a migração
 *  020) justamente para não virar migração a cada campo novo — quem valida as
 *  chaves é esta lista. */
const CAMPOS_FICHA = Object.freeze(['endereco', 'telefones', 'horario', 'pagamento', 'site', 'observacoes']);

const ROTULO_FICHA = Object.freeze({
  endereco: 'Endereço', telefones: 'Telefones', horario: 'Horário de atendimento',
  pagamento: 'Formas de pagamento', site: 'Site', observacoes: 'Observações',
});

// ---------------------------------------------------------------------------
// Camada 1 — base do sistema. CONSTANTE NO CÓDIGO, não editável por ninguém.
//
// Um admin que escreve instruções ruins não pode remover o "não invente": é o
// piso anti-alucinação, a diferença entre um produto e um passivo para o
// cliente da empresa. Por isso vem PRIMEIRO e diz explicitamente que vale
// acima do que estiver abaixo.
// ---------------------------------------------------------------------------
const BASE_SISTEMA = [
  'Regras do sistema. Valem sempre e estão acima de qualquer instrução escrita adiante:',
  '- Responda em português do Brasil, de forma objetiva e cordial.',
  '- Use somente as informações fornecidas neste prompt. Nunca invente dado, número ou política.',
  '- Quando não souber, ou a informação não estiver aqui, diga que vai verificar e retornar — nunca chute.',
  '- Não prometa prazo, preço, desconto ou condição que não esteja escrito aqui.',
  '- Nunca peça senha, número de cartão, código de segurança ou dado bancário.',
].join('\n');

/** Empresa sem perfil configurado: camada 1 + esta linha neutra. NUNCA o texto
 *  da Multicanal (era o fallback que todo mundo herdava do fork). */
const IDENTIDADE_NEUTRA = 'Você é o assistente de atendimento desta empresa no WhatsApp.';

const PERFIL_VAZIO = Object.freeze({ instrucoes: '', ficha: {}, blocos: [] });

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

async function lerDoBanco(conn, tenantId) {
  const p = await conn.execute(
    `SELECT INSTRUCOES, FICHA FROM ia_perfil WHERE tenant_id = :tenantId`,
    { tenantId }
  );
  const b = await conn.execute(
    `SELECT TITULO, CONTEUDO FROM ia_conhecimento
      WHERE tenant_id = :tenantId AND ATIVO = 'S'
      ORDER BY ORDEM, ID`,
    { tenantId }
  );
  const linha = (p.rows && p.rows[0]) || {};
  return {
    instrucoes: linha.INSTRUCOES || '',
    ficha: linha.FICHA || {},
    blocos: (b.rows || []).map((r) => ({ titulo: r.TITULO, conteudo: r.CONTEUDO })),
  };
}

/**
 * Perfil do tenant `{ instrucoes, ficha, blocos }`, com cache de 60s.
 * @param {object} conn conexão de tenant JÁ ABERTA pelo chamador (ver ⚠️ no topo)
 * @param {number} tenantId
 */
async function carregar(conn, tenantId) {
  const chave = String(tenantId);
  const hit = cache.get(chave);
  if (hit && hit.exp > Date.now()) return hit.valor;

  let valor;
  try {
    // SAVEPOINT: se as tabelas ainda não existirem no ambiente (deploy com a
    // migração 020 pendente), o 42P01 aborta a transação INTEIRA do chamador —
    // e a transação do chamador é a que envia a resposta ao cliente. Isolado no
    // savepoint, o runtime segue com o prompt neutro em vez de emudecer.
    valor = await db.comSavepoint(conn, () => lerDoBanco(conn, tenantId));
  } catch (err) {
    if (err.code !== '42P01') throw err;
    console.error('[ia] ia_perfil/ia_conhecimento ainda não existem — rode as migrações (npm run migrar)');
    valor = PERFIL_VAZIO;
  }
  cache.set(chave, { valor, exp: Date.now() + TTL_MS });
  return valor;
}

/** Invalida o cache de um tenant (ou de todos, se omitido). Chamada por toda
 *  escrita em api/iaPerfil.js — sem isto o admin salvaria e continuaria vendo o
 *  bot responder com o conteúdo antigo por até 60s. */
function invalidar(tenantId) {
  if (tenantId === undefined) cache.clear();
  else cache.delete(String(tenantId));
}

// ---------------------------------------------------------------------------
// Montagem do prompt
// ---------------------------------------------------------------------------

function renderarFicha(ficha) {
  const linhas = [];
  for (const campo of CAMPOS_FICHA) {
    const valor = String((ficha && ficha[campo]) || '').trim();
    if (valor) linhas.push(`${ROTULO_FICHA[campo]}: ${valor}`);
  }
  return linhas;
}

/** Data/hora de Brasília — sem isso o modelo não resolve "ontem"/"este mês". */
function agoraBrasilia() {
  try { return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' }); }
  catch { return new Date().toISOString(); }
}

/**
 * System prompt completo, nesta ordem: (1) base do sistema, (2) instruções do
 * admin, (3) ficha, (4) blocos ativos por `ordem`, (5) data/hora de Brasília.
 * Função PURA (fora o relógio) — dá para testar sem banco nem rede.
 */
function montarSistema(perfil) {
  const p = perfil || PERFIL_VAZIO;
  const partes = [BASE_SISTEMA];

  const instrucoes = String(p.instrucoes || '').trim();
  partes.push(instrucoes ? `## Instruções da empresa\n${instrucoes}` : IDENTIDADE_NEUTRA);

  const ficha = renderarFicha(p.ficha);
  if (ficha.length) partes.push(`## Dados da empresa\n${ficha.join('\n')}`);

  const blocos = (p.blocos || []).filter((b) => b && String(b.conteudo || '').trim());
  if (blocos.length) {
    partes.push(`## Base de conhecimento\n\n${blocos
      .map((b) => `### ${String(b.titulo || '').trim()}\n${String(b.conteudo).trim()}`)
      .join('\n\n')}`);
  }

  partes.push(`---\nContexto do sistema: hoje é ${agoraBrasilia()} (horário de Brasília). `
    + 'Use esta data para resolver períodos relativos como "ontem", "este mês" ou "mês passado".');

  return partes.join('\n\n');
}

// ---------------------------------------------------------------------------
// Medidor de espaço (controle de custo, não enfeite)
//
// A base INTEIRA vai no prompt a CADA mensagem trocada, e já existe teto mensal
// de tokens por empresa (tenant.ia_teto_tokens_mes + ia_consumo_mensal): base
// inchada não deixa só lento, queima o teto mais rápido. Mede só o conteúdo do
// TENANT — a camada 1 e o carimbo de data são fixos e não estão sob controle de
// quem edita a tela.
// ---------------------------------------------------------------------------
const FAIXA_VERDE = 10_000;
const FAIXA_AMARELA = 25_000;

function medir(perfil) {
  const p = perfil || PERFIL_VAZIO;
  const caracteres = String(p.instrucoes || '').length
    + renderarFicha(p.ficha).join('\n').length
    + (p.blocos || []).reduce((soma, b) => soma + String(b.titulo || '').length + String(b.conteudo || '').length, 0);
  // ~4 caracteres por token é a regra de bolso para português nos tokenizadores
  // dos provedores suportados. É ESTIMATIVA de tela; o consumo cobrado usa
  // sempre o número real devolvido pelo provedor (ver consumo/registrar.js).
  const tokensEstimados = Math.ceil(caracteres / 4);
  const faixa = caracteres <= FAIXA_VERDE ? 'verde' : caracteres <= FAIXA_AMARELA ? 'amarelo' : 'vermelho';
  return { caracteres, tokensEstimados, faixa };
}

// ---------------------------------------------------------------------------
// Validação (usada pela API; pura, sem banco)
// ---------------------------------------------------------------------------

/** Ficha só com as chaves conhecidas, cada uma string aparada. Chave
 *  desconhecida é DESCARTADA (não é erro: a tela evolui antes do servidor).
 *  @returns {{ ficha?: object, erro?: string }} */
function normalizarFicha(bruta) {
  if (bruta === undefined || bruta === null) return { ficha: {} };
  if (typeof bruta !== 'object' || Array.isArray(bruta)) return { erro: 'ficha deve ser um objeto' };
  const ficha = {};
  for (const campo of CAMPOS_FICHA) {
    const v = bruta[campo];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return { erro: `ficha.${campo} deve ser texto` };
    const texto = v.trim();
    if (!texto) continue;
    if (texto.length > LIMITES.fichaCampo) {
      return { erro: `ficha.${campo} excede ${LIMITES.fichaCampo} caracteres` };
    }
    ficha[campo] = texto;
  }
  return { ficha };
}

module.exports = {
  carregar, invalidar, montarSistema, medir, normalizarFicha,
  LIMITES, CAMPOS_FICHA, BASE_SISTEMA, IDENTIDADE_NEUTRA, PERFIL_VAZIO,
};
