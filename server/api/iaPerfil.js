// api/iaPerfil.js — instruções, ficha e base de conhecimento da IA de UMA
// empresa (FIL-83). Exporta DOIS routers, montados em app.js:
//
//   perfil       → /api/ia-perfil        (GET, PUT, POST /testar)
//   conhecimento → /api/ia-conhecimento  (POST, PUT /:id, DELETE /:id)
//
// Estão no mesmo arquivo porque compartilham o gate de add-on, a validação de
// limites e a invalidação de cache — separar duplicaria os três.
//
// PAPÉIS: ver ADMIN/SUPERVISOR/AUDITOR; editar só ADMIN. Tudo atrás de
// `tenant.ia_habilitada = 'S'` (add-on vendido à parte, quem liga é o operador
// — ver operador/tenants.js::definirIa). A sessão de suporte do operador entra
// como ADMIN (auth/rbac.js::PERFIL_SUPORTE) e escreve, com a auditoria central
// de auth/middleware.js cobrindo — mesma decisão de produto do FIL-70.
//
// ⚠️ NÃO usa a tabela `config`: GET /api/config devolve tudo para QUALQUER
// autenticado (um atendente comum leria as instruções da IA) e o PUT trunca
// valores em 2.000 caracteres, o que mataria um cardápio.
'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const db = require('../db/pool');
const { exigirPapel } = require('../auth/rbac');
const { limiterPorUsuario } = require('../utils/rateLimitPorUsuario');
const perfilStore = require('../ia/perfilStore');
const iaConfigStore = require('../ia/iaConfigStore');
const client = require('../ia/client');
const limitePlano = require('../ia/limitePlano');
const consumo = require('../consumo/registrar');
const precos = require('../consumo/precos');
const extrairArquivo = require('../ia/extrairArquivo');

const { LIMITES } = perfilStore;

// Cada teste chama o provedor de verdade e custa dinheiro (SEGURANCA.md §6:
// rate limit no que custa dinheiro). Teto por USUÁRIO, não só por IP.
const testarIaLimiter = limiterPorUsuario({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.IA_TESTAR_RATE_LIMIT_MAX) || 30,
  mensagem: 'Muitos testes do agente nesta hora. Aguarde antes de testar de novo.',
});

// Gate do add-on de IA. FIL-84: extraído para ia/gate.js quando api/numeros.js
// passou a precisar do mesmo gate (a rota de IA do canal). Roda em transação
// própria e TERMINA antes de o handler abrir a dele.
const { exigirIaHabilitada } = require('../ia/gate');

async function auditar(conn, req, { acao, entidade, entidadeId = null, detalhe = null }) {
  await conn.execute(
    `INSERT INTO auditoria (tenant_id, ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
     VALUES (:tenantId, :atd, :mat, :acao, :ent, :entId, :det)`,
    {
      tenantId: req.tenantId,
      atd: (req.perfil && req.perfil.atendenteId) || null,
      mat: (req.user && req.user.matricula) || null,
      acao, ent: entidade, entId: entidadeId,
      det: detalhe ? JSON.stringify(detalhe) : null,
    }
  );
}

// ===========================================================================
// /api/ia-perfil
// ===========================================================================
const perfil = express.Router();
perfil.use(exigirIaHabilitada);

const PODE_VER = ['ADMIN', 'SUPERVISOR', 'AUDITOR'];

// GET — perfil + TODOS os blocos (inclusive os desligados, que a tela precisa
// mostrar para religar) + medidor. Lê direto do banco, sem passar pelo cache de
// 60s do perfilStore: quem acabou de salvar tem que ver o que salvou.
perfil.get('/', exigirPapel(...PODE_VER), async (req, res, next) => {
  try {
    const dados = await db.comTenant(req.tenantId, async (conn) => {
      const p = await conn.execute(
        `SELECT INSTRUCOES, FICHA, ATUALIZADO_EM FROM ia_perfil WHERE tenant_id = :tenantId`,
        { tenantId: req.tenantId });
      const b = await conn.execute(
        `SELECT ID, TITULO, CONTEUDO, ATIVO, ORDEM, ATUALIZADO_EM FROM ia_conhecimento
          WHERE tenant_id = :tenantId ORDER BY ORDEM, ID`,
        { tenantId: req.tenantId });
      const linha = (p.rows && p.rows[0]) || {};
      return {
        instrucoes: linha.INSTRUCOES || '',
        ficha: linha.FICHA || {},
        atualizadoEm: linha.ATUALIZADO_EM || null,
        blocos: (b.rows || []).map((r) => ({
          id: r.ID, titulo: r.TITULO, conteudo: r.CONTEUDO,
          ativo: r.ATIVO === 'S', ordem: r.ORDEM, atualizadoEm: r.ATUALIZADO_EM,
        })),
      };
    });
    // O medidor conta o que REALMENTE vai no prompt a cada mensagem — só os
    // blocos ativos, portanto.
    const medidor = perfilStore.medir({
      instrucoes: dados.instrucoes, ficha: dados.ficha,
      blocos: dados.blocos.filter((b) => b.ativo),
    });
    res.json({ ...dados, medidor, limites: LIMITES });
  } catch (err) {
    // Ambiente com a migração 020 pendente: tela vazia em vez de 500.
    if (err.code === '42P01') {
      return res.json({ instrucoes: '', ficha: {}, atualizadoEm: null, blocos: [], medidor: perfilStore.medir(null), limites: LIMITES });
    }
    next(err);
  }
});

perfil.put('/', exigirPapel('ADMIN'), async (req, res, next) => {
  const body = req.body || {};
  const instrucoes = String(body.instrucoes || '').trim();
  if (instrucoes.length > LIMITES.instrucoes) {
    return res.status(400).json({ error: `As instruções excedem ${LIMITES.instrucoes} caracteres.` });
  }
  const { ficha, erro } = perfilStore.normalizarFicha(body.ficha);
  if (erro) return res.status(400).json({ error: erro });

  try {
    await db.comTenant(req.tenantId, async (conn) => {
      await conn.execute(
        `INSERT INTO ia_perfil (tenant_id, INSTRUCOES, FICHA, ATUALIZADO_POR, ATUALIZADO_EM)
         VALUES (:tenantId, :ins, :ficha::jsonb, :atd, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           INSTRUCOES = EXCLUDED.INSTRUCOES, FICHA = EXCLUDED.FICHA,
           ATUALIZADO_POR = EXCLUDED.ATUALIZADO_POR, ATUALIZADO_EM = now()`,
        {
          tenantId: req.tenantId, ins: instrucoes || null, ficha: JSON.stringify(ficha),
          atd: (req.perfil && req.perfil.atendenteId) || null,
        });
      await auditar(conn, req, {
        acao: 'ia_perfil_salvo', entidade: 'ia_perfil',
        detalhe: { instrucoesChars: instrucoes.length, fichaCampos: Object.keys(ficha) },
      });
    });
    perfilStore.invalidar(req.tenantId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /testar — pergunta avulsa contra a configuração SALVA, sem ferramentas.
// Registra consumo e respeita o teto mensal: sem isso vira porta dos fundos
// para gastar token do provedor sem aparecer no consumo do cliente.
perfil.post('/testar', exigirPapel('ADMIN'), testarIaLimiter, async (req, res, next) => {
  const pergunta = String((req.body && req.body.pergunta) || '').trim();
  if (!pergunta) return res.status(400).json({ error: 'Escreva uma pergunta para testar.' });
  if (pergunta.length > 2000) return res.status(400).json({ error: 'Pergunta excede 2000 caracteres.' });

  try {
    // Fase 1 — transação de tenant: teto + perfil. Devolve a conexão ANTES de
    // falar com o provedor (a chamada externa leva até 45s; segurar a conexão
    // durante ela esgota o pool sob concorrência — mesmo racional de
    // api/conversas.js::/sugestao-resposta).
    const sistema = await db.comTenant(req.tenantId, async (conn) => {
      if (await limitePlano.estourouTeto(conn, req.tenantId)) {
        const e = new Error('teto'); e.http = 400;
        e.body = { error: 'Limite mensal de uso de IA atingido para esta empresa. Fale com o Falatta para revisar o plano.' };
        throw e;
      }
      return perfilStore.montarSistema(await perfilStore.carregar(conn, req.tenantId));
    });

    // Fase 2 — nenhuma conexão aberta: credencial e preço abrem transação de
    // OPERADOR por baixo dos panos (ver ia/iaConfigStore.js).
    const config = await iaConfigStore.carregar(req.tenantId);
    if (!config) return res.status(400).json({ error: 'Nenhum provedor de IA configurado. Fale com o time Falatta.' });
    const preco = await precos.carregarPreco(config.provider, config.modelo);

    const out = await client.chamar({
      config, sistema, semFerramentas: true,
      mensagens: [{ papel: 'user', texto: pergunta }],
    });
    const resposta = (out.texto || '').trim();

    // Fase 3 — mede o que foi gasto. Best-effort: nunca derruba a resposta já
    // gerada (ver consumo/registrar.js).
    const uso = out.uso || null;
    if (uso && (uso.tokensEntrada > 0 || uso.tokensSaida > 0)) {
      try {
        await db.comTenant(req.tenantId, (conn) => consumo.registrarIaTokens(conn, req.tenantId, {
          tokensEntrada: uso.tokensEntrada, tokensSaida: uso.tokensSaida, preco,
        }));
      } catch (e) {
        console.error('[consumo] falha ao registrar consumo do teste de IA (não afeta a resposta):', e.message);
      }
    }

    if (!resposta) return res.status(502).json({ error: 'O provedor não retornou resposta.' });
    res.json({ resposta });
  } catch (err) {
    if (err && err.http) return res.status(err.http).json(err.body);
    if (err && err.code === '42P01') return next(err);
    res.status(502).json({ error: err.message || 'Falha ao testar o agente.' });
  }
});

// ===========================================================================
// /api/ia-conhecimento — só ADMIN escreve (a leitura vem no GET /api/ia-perfil)
// ===========================================================================
const conhecimento = express.Router();
conhecimento.use(exigirIaHabilitada, exigirPapel('ADMIN'));

// Extração é CPU-bound (parse de PDF/XLSX), não $-cost como /testar — mesmo
// padrão de teto por USUÁRIO, janela mais curta e teto mais folgado.
const extrairIaLimiter = limiterPorUsuario({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.IA_EXTRAIR_RATE_LIMIT_MAX) || 20,
  mensagem: 'Muitos arquivos enviados em pouco tempo. Aguarde um instante antes de tentar de novo.',
});

const EXTENSOES_ACEITAS = new Set(['.pdf', '.xlsx', '.csv']);

const uploadExtrair = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** POST /extrair — STATELESS: extrai texto do arquivo e devolve blocos
 *  PROPOSTOS, sem gravar nada. Quem persiste é o POST/PUT normal desta mesma
 *  rota, que já audita e invalida o cache (ver cabeçalho do arquivo). Falhou
 *  ou o admin abandonou a revisão: não sobra lixo no banco. */
conhecimento.post('/extrair', extrairIaLimiter, (req, res, next) => {
  uploadExtrair.single('arquivo')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo excede 10 MB.' : 'Falha no upload do arquivo.';
    res.status(400).json({ error: msg });
  });
}, async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  // busboy (multer 2.x) decodifica o header Content-Disposition como latin1
  // por padrão — nome de arquivo acentuado ("Cardápio.pdf", comum aqui) sai
  // com "Ã¡" no lugar de "á" a não ser que a gente refaça o decode como UTF-8.
  const nomeOriginal = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8');
  const ext = path.extname(nomeOriginal).toLowerCase();
  if (!EXTENSOES_ACEITAS.has(ext)) {
    return res.status(400).json({ error: 'Formato não suportado. Envie PDF, XLSX ou CSV.' });
  }
  const tituloBase = path.basename(nomeOriginal, ext).trim() || 'Arquivo';

  try {
    let texto;
    if (ext === '.pdf') texto = await extrairArquivo.extrairPdf(req.file.buffer);
    else if (ext === '.xlsx') texto = await extrairArquivo.extrairXlsx(req.file.buffer);
    else texto = extrairArquivo.extrairCsv(req.file.buffer);

    const propostos = extrairArquivo.propostaBlocos(tituloBase, texto, LIMITES.blocoConteudo, LIMITES.blocoTitulo);
    if (!propostos.length) return res.status(422).json({ error: 'Não foi possível extrair texto deste arquivo.' });

    // Teto de blocos por empresa é checado ANTES de mostrar o preview — de
    // nada adianta o admin revisar 12 blocos pra descobrir só no salvar que
    // não cabiam.
    const totalAtual = await db.comTenant(req.tenantId, async (conn) => {
      const c = await conn.execute(`SELECT count(*)::int AS N FROM ia_conhecimento WHERE tenant_id = :tenantId`, { tenantId: req.tenantId });
      return Number((c.rows[0] || {}).N || 0);
    });
    if (totalAtual + propostos.length > LIMITES.blocos) {
      return res.status(400).json({
        error: `Este arquivo geraria ${propostos.length} bloco(s), o que ultrapassaria o limite de ${LIMITES.blocos} blocos por empresa (${totalAtual} já existente(s)).`,
      });
    }

    res.json({ blocos: propostos });
  } catch (err) {
    if (err instanceof extrairArquivo.ArquivoInvalido) return res.status(422).json({ error: err.message });
    if (err instanceof extrairArquivo.LimiteExcedido) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/** @returns {{ titulo?, conteudo?, ativo?, ordem?, erro? }} */
function validarBloco(body, { parcial = false } = {}) {
  const out = {};
  const temTitulo = body.titulo !== undefined;
  const temConteudo = body.conteudo !== undefined;

  if (!parcial || temTitulo) {
    const titulo = String(body.titulo || '').trim();
    if (!titulo) return { erro: 'Título obrigatório.' };
    if (titulo.length > LIMITES.blocoTitulo) return { erro: `Título excede ${LIMITES.blocoTitulo} caracteres.` };
    out.titulo = titulo;
  }
  if (!parcial || temConteudo) {
    const conteudo = String(body.conteudo || '').trim();
    if (!conteudo) return { erro: 'Conteúdo obrigatório.' };
    if (conteudo.length > LIMITES.blocoConteudo) return { erro: `Conteúdo excede ${LIMITES.blocoConteudo} caracteres.` };
    out.conteudo = conteudo;
  }
  if (body.ativo !== undefined) out.ativo = body.ativo === true || body.ativo === 'S' ? 'S' : 'N';
  if (body.ordem !== undefined) {
    const ordem = Number(body.ordem);
    if (!Number.isInteger(ordem) || ordem < 0 || ordem > 9999) return { erro: 'Ordem inválida.' };
    out.ordem = ordem;
  }
  return out;
}

conhecimento.post('/', async (req, res, next) => {
  const v = validarBloco(req.body || {});
  if (v.erro) return res.status(400).json({ error: v.erro });
  try {
    const id = await db.comTenant(req.tenantId, async (conn) => {
      const c = await conn.execute(
        `SELECT count(*)::int AS N FROM ia_conhecimento WHERE tenant_id = :tenantId`,
        { tenantId: req.tenantId });
      if (Number((c.rows[0] || {}).N || 0) >= LIMITES.blocos) {
        const e = new Error('limite'); e.http = 400;
        e.body = { error: `Limite de ${LIMITES.blocos} blocos por empresa atingido. Remova ou desative algum antes de adicionar outro.` };
        throw e;
      }
      const { tipos } = db;
      const ins = await conn.execute(
        `INSERT INTO ia_conhecimento (tenant_id, TITULO, CONTEUDO, ATIVO, ORDEM, ATUALIZADO_EM)
         VALUES (:tenantId, :t, :c, :a, :o, now()) RETURNING id INTO :id`,
        {
          tenantId: req.tenantId, t: v.titulo, c: v.conteudo,
          a: v.ativo || 'S', o: v.ordem === undefined ? 0 : v.ordem,
          id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
        });
      const novoId = ins.outBinds.id[0];
      await auditar(conn, req, { acao: 'ia_conhecimento_add', entidade: 'ia_conhecimento', entidadeId: novoId, detalhe: { titulo: v.titulo } });
      return novoId;
    });
    perfilStore.invalidar(req.tenantId);
    res.json({ ok: true, id });
  } catch (err) {
    if (err && err.http) return res.status(err.http).json(err.body);
    next(err);
  }
});

conhecimento.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  const v = validarBloco(req.body || {}, { parcial: true });
  if (v.erro) return res.status(400).json({ error: v.erro });
  const campos = ['titulo', 'conteudo', 'ativo', 'ordem'].filter((k) => v[k] !== undefined);
  if (!campos.length) return res.status(400).json({ error: 'Nada para atualizar.' });

  const COLUNA = { titulo: 'TITULO', conteudo: 'CONTEUDO', ativo: 'ATIVO', ordem: 'ORDEM' };
  const sets = campos.map((k) => `${COLUNA[k]} = :${k}`).join(', ');
  const binds = { tenantId: req.tenantId, id };
  for (const k of campos) binds[k] = v[k];

  try {
    const achou = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `UPDATE ia_conhecimento SET ${sets}, ATUALIZADO_EM = now()
          WHERE tenant_id = :tenantId AND ID = :id`, binds);
      if (!r.rowsAffected) return false;
      await auditar(conn, req, { acao: 'ia_conhecimento_edit', entidade: 'ia_conhecimento', entidadeId: id, detalhe: { campos } });
      return true;
    });
    if (!achou) return res.status(404).json({ error: 'Bloco não encontrado' });
    perfilStore.invalidar(req.tenantId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Remoção REAL: nada referencia o bloco. Quem quer só tirar do prompt sem
// perder o texto usa ativo='N' (cardápio sazonal, promoção encerrada).
conhecimento.delete('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const achou = await db.comTenant(req.tenantId, async (conn) => {
      const r = await conn.execute(
        `DELETE FROM ia_conhecimento WHERE tenant_id = :tenantId AND ID = :id`,
        { tenantId: req.tenantId, id });
      if (!r.rowsAffected) return false;
      await auditar(conn, req, { acao: 'ia_conhecimento_del', entidade: 'ia_conhecimento', entidadeId: id });
      return true;
    });
    if (!achou) return res.status(404).json({ error: 'Bloco não encontrado' });
    perfilStore.invalidar(req.tenantId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { perfil, conhecimento };
