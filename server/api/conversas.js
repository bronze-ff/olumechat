// api/conversas.js — Lista de conversas, mensagens e ENVIO (Fase 2).
// Leitura vem do que o webhook gravou; o envio usa o número da própria
// conversa (multi-número via `numero`) e persiste a saída no histórico.
// Toda query roda dentro de db.comTenant(req.tenantId, ...) — RLS isola por
// tenant automaticamente (ver db/pool.js). req.tenantId é setado por
// middleware de autenticação (fora do escopo deste módulo).
const express = require('express');
const db = require('../db/pool');
const { mapRows, mapRow } = require('../utils/linhas');
const { sendText } = require('../graph/sendText');
const { sendTemplate } = require('../graph/sendTemplate');
const { cfg } = require('../graph/client');
const { publish } = require('../realtime/hub');
const { normalizar: normalizePhone, acharContato } = require('../utils/telefone');
const { acharClientePorTelefone } = require('../utils/clienteLookup');
const { exigirPapel } = require('../auth/rbac');
const iaConfigStore = require('../ia/iaConfigStore');
const sugestaoResposta = require('../ia/sugestaoResposta');
const limitePlano = require('../ia/limitePlano');
const consumo = require('../consumo/registrar');
const { limiterPorUsuario } = require('../utils/rateLimitPorUsuario');

const router = express.Router();

// B2: cada chamada de sugestão custa dinheiro de verdade no provedor de LLM.
// Teto conservador por usuário (não só IP), configurável por env.
const sugestaoIaLimiter = limiterPorUsuario({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.SUGESTAO_IA_RATE_LIMIT_MAX) || 20,
  mensagem: 'Muitas sugestões de IA nesta hora. Aguarde antes de pedir outra.',
});

// B3: cada envio (texto OU arquivo) é uma chamada paga à Cloud API da Meta —
// as duas rotas dividem o mesmo teto por usuário. 60/min é generoso pro
// atendimento humano (cobre rajada de ~1 msg/seg) e ainda barra um script
// disparando em loop. Configurável por env.
const envioLimiter = limiterPorUsuario({
  windowMs: 60 * 1000,
  max: Number(process.env.ENVIO_RATE_LIMIT_MAX) || 60,
  mensagem: 'Muitos envios em pouco tempo. Aguarde um instante antes de continuar.',
});

/** Curto-circuito para responder HTTP de dentro de um callback comTenant() sem
    que vire um 500: a rota captura e responde com o status/body pedidos. */
class RespostaHttp extends Error {
  constructor(status, body) {
    super('RespostaHttp');
    this.status = status;
    this.body = body;
  }
}

/**
 * Roda `fn` isolado num SAVEPOINT da transação corrente. Usado nos loops de
 * ação em lote (forçar-transferir/forçar-finalizar): sem isso, um erro de
 * verdade num item deixa a transação Postgres inteira ABORTADA (25P02) — todo
 * item SEGUINTE do lote falharia também, mas pelo motivo errado (a resposta
 * `{ ok, erros }` prometeria partial-success que não aconteceu de verdade). O
 * catch do chamador continua tratando "não encontrada"/"já resolvida" como
 * skip normal (função devolve sem lançar); só erro de verdade dá ROLLBACK TO
 * SAVEPOINT antes de propagar.
 */
async function comSavepoint(conn, fn) {
  await conn.execute('SAVEPOINT lote_item');
  try {
    const resultado = await fn();
    await conn.execute('RELEASE SAVEPOINT lote_item');
    return resultado;
  } catch (err) {
    await conn.execute('ROLLBACK TO SAVEPOINT lote_item').catch(() => {});
    throw err;
  }
}

/** Bloqueia AUDITOR (papel SOMENTE-LEITURA) nas rotas de mutação. ADMIN/SUPERVISOR/
    ATENDENTE seguem; demais checagens (escopo, podeAtivo, gestor) continuam valendo. */
function naoAuditor(req, res, next) {
  if (req.perfil && req.perfil.papel === 'AUDITOR') {
    return res.status(403).json({ error: 'Perfil somente-leitura (AUDITOR) não pode executar esta ação.' });
  }
  next();
}

/**
 * A Cloud API entrega todas as mensagens como o mesmo número comercial; ela
 * não tem o rótulo nativo de agente visto em alguns produtos. Prefixamos a
 * mensagem humana para o cliente sempre saber quem está falando.
 */
function identificarAtendente(nome, texto) {
  const seguro = String(nome || 'Equipe').replace(/[*_~`\r\n]/g, '').trim().slice(0, 80) || 'Equipe';
  return `*${seguro}:*\n${texto}`;
}

/**
 * Carrega a conversa por ID VALIDANDO o escopo do perfil (mesma regra da lista):
 * ADMIN/AUDITOR veem tudo; demais só conversa do seu departamento, atribuída a
 * si, sem departamento, e — se tiver números restritos — do seu canal.
 * Devolve a linha {ID, DEPARTAMENTO_ID, NUMERO_ID, ATENDENTE_ID} ou null (fora
 * do escopo ou inexistente → o chamador responde 404, sem distinguir os casos).
 * Fecha o buraco de IDOR: sem isso, qualquer atendente acessava/alterava
 * conversa de qualquer um iterando o ID.
 */
async function conversaNoEscopo(conn, id, perfil) {
  const r = await conn.execute(
    `SELECT id, departamento_id, numero_id, atendente_id FROM conversa WHERE id = :id`,
    { id }
  );
  if (!r.rows.length) return null;
  const c = r.rows[0];
  if (!perfil || perfil.papel === 'ADMIN' || perfil.papel === 'AUDITOR') return c;
  const ehMinha = perfil.atendenteId && c.ATENDENTE_ID === perfil.atendenteId;
  const deptoOk = c.DEPARTAMENTO_ID == null || ehMinha || (perfil.deptoIds || []).includes(c.DEPARTAMENTO_ID);
  if (!deptoOk) return null;
  // Visibilidade exclusiva (espelha a lista): atendente comum só acessa conversa
  // atribuída a ele ou ainda sem dono; chat de um colega fica restrito. GESTOR
  // (SUPERVISOR) e ADMIN/AUDITOR veem tudo (estes últimos já retornaram acima).
  if (perfil.papel !== 'SUPERVISOR' && !ehMinha && c.ATENDENTE_ID != null) return null;
  const meusNum = perfil.numeroIds || [];
  const numOk = !meusNum.length || c.NUMERO_ID == null || ehMinha || meusNum.includes(c.NUMERO_ID);
  if (!numOk) return null;
  return c;
}

/** Acha/cria contato por telefone (casa variantes do 9º dígito); atualiza CODIGO_EXTERNO. */
async function getOrCreateContato(conn, telefone, codigoExterno) {
  const { tipos } = db;
  const achado = await acharContato(conn, telefone);
  if (achado) {
    const id = achado.ID;
    if (codigoExterno) {
      await conn.execute(
        `UPDATE contato SET codigo_externo = :c WHERE id = :id AND codigo_externo IS NULL`,
        { c: codigoExterno, id }
      );
    }
    return id;
  }
  // Auto-identificação (igual ao receptivo): sem código informado, casa o telefone
  // com o seam clienteLookup e já preenche codigo_externo + documento + nome
  // interno (razão social).
  let cli = null;
  if (!codigoExterno) { try { cli = await acharClientePorTelefone(conn, telefone); } catch { cli = null; } }
  const ins = await conn.execute(
    `INSERT INTO contato (telefone, codigo_externo, documento, nome_interno)
     VALUES (:tel, :cod, :doc, :ni) RETURNING id INTO :id`,
    { tel: telefone,
      cod: codigoExterno || (cli ? cli.codigo : null),
      doc: cli ? cli.documento : null,
      ni: cli ? cli.nome : null,
      id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
  );
  return ins.outBinds.id[0];
}

/** Garante o atendente (por matrícula do JWT) e devolve o ID. */
async function getOrCreateAtendente(conn, user) {
  if (!user || !user.matricula) return null;
  const sel = await conn.execute(
    `SELECT id FROM atendente WHERE matricula = :m`,
    { m: user.matricula }
  );
  if (sel.rows.length) return sel.rows[0].ID;
  const { tipos } = db;
  const ins = await conn.execute(
    `INSERT INTO atendente (matricula, nome) VALUES (:m, :n)
     RETURNING id INTO :id`,
    { m: user.matricula, n: user.nome || null, id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
  );
  return ins.outBinds.id[0];
}

// POST /api/conversas — INICIA contato (fora da janela 24h → via template).
// body: { telefone, codigoExterno?, templateName, lang?, variaveis?[], preview? }
router.post('/', naoAuditor, async (req, res, next) => {
  const b = req.body || {};
  const telefone = normalizePhone(b.telefone);
  const templateName = String(b.templateName || '').trim();
  const lang = String(b.lang || 'pt_BR');
  const variaveis = Array.isArray(b.variaveis) ? b.variaveis.map(String) : [];
  if (telefone.length < 12) return res.status(400).json({ error: 'Telefone inválido (use DDD + número).' });
  if (!templateName) return res.status(400).json({ error: 'Selecione um template.' });
  // Permissão: só ADMIN ou atendente com PODE_ATIVO inicia conversa ativa (paga).
  if (!(req.perfil && req.perfil.podeAtivo)) {
    return res.status(403).json({ error: 'Você não tem permissão para iniciar conversas ativas. Peça a um ADMIN para liberar em Atendentes.' });
  }

  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      const contatoId = await getOrCreateContato(conn, telefone, b.codigoExterno ? Number(b.codigoExterno) : null);

      // Opt-out (LGPD): bloqueia se a ação MAIS RECENTE do contato for 'optout'
      // (assim um "VOLTAR" posterior reabilita o disparo).
      const opt = await conn.execute(
        `SELECT acao FROM auditoria
          WHERE entidade = 'contato' AND entidade_id = :id AND acao IN ('optin', 'optout')
          ORDER BY criado_em DESC, id DESC FETCH FIRST 1 ROWS ONLY`,
        { id: contatoId }
      );
      if (opt.rows.length && opt.rows[0].ACAO === 'optout') {
        throw new RespostaHttp(409, { error: 'Cliente optou por não receber mensagens ("PARAR").' });
      }

      // Número de origem: o escolhido na tela (numeroId) ou o padrão do .env.
      // Só números com PERMITE_ATIVO='S' podem originar conversa ativa — assim o
      // número receptivo (ex.: 1090, com fluxo) fica fora do disparo manual.
      let numeroId = null;
      let phoneNumberIdEnvio; // undefined = padrão do .env
      let deptoPadraoNumero = null; // departamento padrão configurado no número
      const numSel = b.numeroId
        ? await conn.execute(
            `SELECT id, phone_number_id, permite_ativo, ativo, departamento_padrao_id FROM numero WHERE id = :id`,
            { id: Number(b.numeroId) })
        : await conn.execute(
            `SELECT id, phone_number_id, permite_ativo, ativo, departamento_padrao_id FROM numero WHERE phone_number_id = :p`,
            { p: cfg.phoneNumberId });
      if (b.numeroId && !numSel.rows.length) {
        throw new RespostaHttp(400, { error: 'Número de origem não encontrado.' });
      }
      if (numSel.rows.length) {
        const num = numSel.rows[0];
        if (num.ATIVO === 'N') throw new RespostaHttp(409, { error: 'Esse número está inativo.' });
        if (num.PERMITE_ATIVO === 'N') {
          throw new RespostaHttp(409, { error: 'Esse número não permite conversa ativa. Escolha um número habilitado (Admin → Números).' });
        }
        // Acesso por número: atendente restrito só envia pelos números dele.
        const meusNum = (req.perfil && req.perfil.numeroIds) || [];
        if (meusNum.length && !meusNum.includes(num.ID)) {
          throw new RespostaHttp(403, { error: 'Você não tem acesso a esse número de origem.' });
        }
        numeroId = num.ID;
        phoneNumberIdEnvio = num.PHONE_NUMBER_ID || undefined;
        deptoPadraoNumero = num.DEPARTAMENTO_PADRAO_ID || null;
      }

      // Departamento da conversa ativa: a escolha explícita do modal (quando o
      // número NÃO tem padrão) vem primeiro; senão o DEPARTAMENTO_PADRAO_ID do
      // número (ex.: 1061 → Cobrança); senão NULL = inbox geral. Sem isso a
      // conversa nascia sempre no "Geral" e sumia das métricas/relatório do depto.
      let departamentoId = b.departamentoId ? Number(b.departamentoId) : null;
      if (departamentoId) {
        const dch = await conn.execute(
          `SELECT id FROM departamento WHERE id = :id AND ativo = 'S'`, { id: departamentoId });
        if (!dch.rows.length) throw new RespostaHttp(400, { error: 'Departamento inválido.' });
        // Escopo: atendente restrito só direciona para um departamento seu.
        const ehAmplo = req.perfil.papel === 'ADMIN' || req.perfil.papel === 'SUPERVISOR';
        const meusDep = req.perfil.deptoIds || [];
        if (!ehAmplo && meusDep.length && !meusDep.includes(departamentoId)) {
          throw new RespostaHttp(403, { error: 'Você não tem acesso a esse departamento.' });
        }
      } else {
        departamentoId = deptoPadraoNumero;
      }

      // Envia o template (inicia a conversa; NÃO abre a janela de 24h — isso só
      // acontece quando o cliente responder).
      const resp = await sendTemplate(telefone, templateName, lang, variaveis, phoneNumberIdEnvio);
      const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;

      const atendenteId = await getOrCreateAtendente(conn, req.user);

      // Conversa: reaproveita a aberta, senão cria como ATIVA (empresa iniciou),
      // com protocolo e atribuída a quem disparou.
      const { tipos } = db;
      let conversaId;
      const cv = await conn.execute(
        `SELECT id FROM conversa WHERE contato_id = :c AND status <> 'resolvida'
          ORDER BY criado_em DESC FETCH FIRST 1 ROWS ONLY`, { c: contatoId }
      );
      if (cv.rows.length) {
        conversaId = cv.rows[0].ID;
        // Reaproveitada: só preenche o departamento se ainda estiver sem (COALESCE
        // preserva uma fila já atribuída; não "rouba" a conversa de outra área).
        if (departamentoId) {
          await conn.execute(
            `UPDATE conversa
                SET ultima_msg_em = now(), departamento_id = COALESCE(departamento_id, :dep)
              WHERE id = :id`,
            { dep: departamentoId, id: conversaId });
        } else {
          await conn.execute(`UPDATE conversa SET ultima_msg_em = now() WHERE id = :id`, { id: conversaId });
        }
      } else {
        const { gerarProtocolo } = require('../fila/protocolo');
        const protocolo = await gerarProtocolo(conn);
        const insC = await conn.execute(
          `INSERT INTO conversa
             (contato_id, numero_id, departamento_id, atendente_id, status, fila_status, origem, protocolo,
              ultima_msg_em, atribuida_em)
           VALUES (:c, :n, :dep, :atd, 'aberta', 'em_atendimento', 'ativa', :prot,
              now(), now()) RETURNING id INTO :id`,
          { c: contatoId, n: numeroId, dep: departamentoId, atd: atendenteId, prot: protocolo,
            id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
        );
        conversaId = insC.outBinds.id[0];
      }
      const conteudo = b.preview ? String(b.preview) : `[template: ${templateName}]`;
      await conn.execute(
        `INSERT INTO mensagem
           (conversa_id, contato_id, numero_id, atendente_id, wamid, direcao, tipo, conteudo, status, ts)
         VALUES (:cv, :ct, :num, :atd, :wamid, 'out', 'template', :txt, 'sent', now())`,
        { cv: conversaId, ct: contatoId, num: numeroId, atd: atendenteId, wamid: wamid || null, txt: conteudo }
      );
      return { id: conversaId, contatoId, telefone, departamentoId: departamentoId || null, wamid };
    });

    publish({ tipo: 'mensagem', direcao: 'out', conversaId: resultado.id, contatoId: resultado.contatoId, departamentoId: resultado.departamentoId, tenantId: req.tenantId });
    res.status(201).json(resultado);
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    if (err.isGraphError) {
      return res.status(502).json({ error: err.message, codigo: err.graphCode });
    }
    next(err);
  }
});

// GET /api/conversas — lista com contato + última mensagem (Fase 5B: escopo
// por perfil e filtros de fila).
// Query: ?q= (nome/telefone/codigoExterno/protocolo) · ?fila= · ?departamentoId= · ?minhas=1
//        · ?origem=ativa|receptiva · ?janela=aberta|fechada · ?numeroId= · ?semDono=1
// Escopo: ADMIN/AUDITOR veem tudo; demais veem conversas dos seus departamentos,
// as atribuídas a si e as sem departamento (inbox geral).
router.get('/', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  const fila = String(req.query.fila || '').trim();
  const departamentoId = Number(req.query.departamentoId) || null;
  const minhas = req.query.minhas === '1';
  // Filtros extras do inbox (separar volume): origem (ativa/receptiva), estado da
  // janela de 24h (aberta/fechada), canal (número) e só as ainda sem dono na fila.
  const origem = ['ativa', 'receptiva'].includes(req.query.origem) ? req.query.origem : null;
  const janela = ['aberta', 'fechada'].includes(req.query.janela) ? req.query.janela : null;
  const numeroFiltro = Number(req.query.numeroId) || null;
  const naoAtribuida = req.query.semDono === '1';
  const perfil = req.perfil || { papel: 'ADMIN', deptoIds: [], atendenteId: null };
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      const binds = {};
      const conds = [];
      if (q) {
        conds.push(`(UPPER(ct.nome_perfil) LIKE UPPER('%'||:q||'%')
                     OR ct.telefone LIKE '%'||:qd||'%'
                     OR ct.codigo_externo::text = :qc
                     OR c.protocolo = :qp)`);
        binds.q = q;
        binds.qd = q.replace(/\D/g, '') || ' ';
        binds.qc = q.replace(/\D/g, '') || ' ';
        binds.qp = q.replace(/\D/g, '') || ' ';
      }
      if (['aguardando', 'em_atendimento', 'resolvida', 'bot', 'ia'].includes(fila)) {
        conds.push(`c.fila_status = :fila`);
        binds.fila = fila;
      }
      if (departamentoId) {
        conds.push(`c.departamento_id = :depFiltro`);
        binds.depFiltro = departamentoId;
      }
      if (minhas && perfil.atendenteId) {
        conds.push(`c.atendente_id = :meuId`);
        binds.meuId = perfil.atendenteId;
      }
      if (origem) {
        conds.push(`c.origem = :origem`);
        binds.origem = origem;
      }
      // Janela de 24h: aberta = ainda dá texto livre; fechada = nunca abriu OU expirou.
      // A janela só faz sentido para atendimentos ABERTOS: um encerrado não é
      // respondável (nova mensagem abre outro atendimento), então os filtros de
      // janela ignoram resolvidas — salvo quando o usuário está na aba Resolvidas
      // (aí o filtro age dentro delas, em vez de zerar a lista).
      if (janela) {
        if (janela === 'aberta') {
          conds.push(`c.janela_expira_em > now()`);
        } else {
          conds.push(`(c.janela_expira_em IS NULL OR c.janela_expira_em <= now())`);
        }
        if (fila !== 'resolvida') conds.push(`c.fila_status <> 'resolvida'`);
      }
      if (numeroFiltro) {
        conds.push(`c.numero_id = :numFiltro`);
        binds.numFiltro = numeroFiltro;
      }
      if (naoAtribuida) {
        conds.push(`c.atendente_id IS NULL`);
      }
      // Escopo por papel.
      if (perfil.papel !== 'ADMIN' && perfil.papel !== 'AUDITOR') {
        // Visibilidade exclusiva: o ATENDENTE comum só vê a conversa atribuída a
        // ELE ou ainda SEM dono (na fila). Chat já atribuído a um colega some da
        // lista. GESTOR (SUPERVISOR) continua vendo TODO o departamento, para
        // supervisão (ADMIN/AUDITOR nem entram aqui — veem tudo).
        const semDono = perfil.papel === 'SUPERVISOR' ? '' : ` AND c.atendente_id IS NULL`;
        const partes = [`(c.departamento_id IS NULL${semDono})`];
        if (perfil.atendenteId) {
          partes.push(`c.atendente_id = :escopoAtd`);
          binds.escopoAtd = perfil.atendenteId;
        }
        if (perfil.deptoIds.length) {
          const ms = perfil.deptoIds.map((d, i) => { binds[`escDep${i}`] = d; return `:escDep${i}`; });
          partes.push(`(c.departamento_id IN (${ms.join(',')})${semDono})`);
        }
        conds.push(`(${partes.join(' OR ')})`);

        // Escopo por NÚMERO (canal): se o atendente tem números cadastrados, só vê
        // conversas desses números (+ sem número + as atribuídas a ele). Lista
        // vazia = sem restrição. Separa ativo (1061) de receptivo (1090) na fila.
        if (perfil.numeroIds && perfil.numeroIds.length) {
          const partesNum = [`c.numero_id IS NULL`];
          const ns = perfil.numeroIds.map((n, i) => { binds[`escNum${i}`] = n; return `:escNum${i}`; });
          partesNum.push(`c.numero_id IN (${ns.join(',')})`);
          if (perfil.atendenteId) partesNum.push(`c.atendente_id = :escopoAtd`); // já bindado acima
          conds.push(`(${partesNum.join(' OR ')})`);
        }
      }
      const filtro = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const result = await conn.execute(
        `SELECT c.id, c.status, c.janela_expira_em, c.ultima_msg_em, c.numero_id, c.tags,
                c.fila_status, c.protocolo, c.departamento_id, c.atendente_id, c.origem,
                ct.id AS contato_id, ct.telefone, ct.nome_perfil, ct.nome_interno, ct.documento, ct.codigo_externo,
                a.nome AS atendente_nome,
                d.nome AS departamento_nome, d.cor AS departamento_cor,
                n.nome_exibicao AS numero_nome, n.display_phone AS numero_fone,
                (SELECT mm.conteudo FROM mensagem mm
                   WHERE mm.tenant_id = c.tenant_id AND mm.conversa_id = c.id
                   ORDER BY mm.ts DESC NULLS LAST, mm.id DESC
                   FETCH FIRST 1 ROWS ONLY) AS ultima_msg
           FROM conversa c
           JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
           LEFT JOIN atendente a ON a.tenant_id = c.tenant_id AND a.id = c.atendente_id
           LEFT JOIN departamento d ON d.tenant_id = c.tenant_id AND d.id = c.departamento_id
           LEFT JOIN numero n ON n.tenant_id = c.tenant_id AND n.id = c.numero_id
          ${filtro}
          ORDER BY c.ultima_msg_em DESC NULLS LAST, c.id DESC
          FETCH FIRST 100 ROWS ONLY`,
        binds
      );
      return result.rows;
    });
    // TAGS é jsonb (array de IDs) — o driver já devolve parseado.
    const linhas = mapRows(rows).map((r) => ({
      ...r,
      tags: r.tags || [],
      ultimaMsg: r.ultimaMsg,
      nomePerfil: r.nomePerfil,
      nomeInterno: r.nomeInterno,
    }));
    res.json(linhas);
  } catch (err) {
    next(err);
  }
});

// GET /api/conversas/contagens — contagem REAL (COUNT no banco) por departamento
// e por atendente, SEM o teto de 100 linhas da listagem. A listagem (GET /) corta
// em FETCH FIRST 100, então o Monitor, que contava em cima dela, subcontava (mostrava
// 100 com 118 reais). Aqui o número é exato. Gestor-only, visão global (como o
// /presenca, que já devolve a equipe inteira sem escopo).
router.get('/contagens', exigirPapel('ADMIN', 'SUPERVISOR', 'AUDITOR'), async (req, res, next) => {
  try {
    const { porDep, porAtd } = await db.comTenant(req.tenantId, async (conn) => {
      const dep = await conn.execute(
        `SELECT COALESCE(departamento_id, 0) AS dep, fila_status, COUNT(*) AS qtd
           FROM conversa
          WHERE fila_status IN ('aguardando', 'em_atendimento')
          GROUP BY COALESCE(departamento_id, 0), fila_status`,
        {}
      );
      const atd = await conn.execute(
        `SELECT atendente_id AS atd, COUNT(*) AS qtd
           FROM conversa
          WHERE fila_status = 'em_atendimento' AND atendente_id IS NOT NULL
          GROUP BY atendente_id`,
        {}
      );
      return { porDep: dep.rows, porAtd: atd.rows };
    });
    const porDepartamento = {};
    for (const r of mapRows(porDep)) {
      if (!porDepartamento[r.dep]) porDepartamento[r.dep] = { aguardando: 0, em_atendimento: 0 };
      porDepartamento[r.dep][r.filaStatus] = r.qtd;
    }
    const porAtendente = {};
    for (const r of mapRows(porAtd)) porAtendente[r.atd] = r.qtd;
    res.json({ porDepartamento, porAtendente });
  } catch (err) {
    next(err);
  }
});

// GET /api/conversas/:id/mensagens — thread completa (ordem cronológica).
router.get('/:id/mensagens', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const rows = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }
      const result = await conn.execute(
        `SELECT id, direcao, tipo, conteudo, status, ts,
                media_id, mime_type, nome_arquivo,
                CASE WHEN midia_caminho IS NOT NULL THEN 1 ELSE 0 END AS tem_arquivo
           FROM mensagem
          WHERE conversa_id = :id
          ORDER BY ts ASC NULLS LAST, id ASC`,
        { id }
      );
      return result.rows;
    });
    res.json(mapRows(rows));
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    next(err);
  }
});

// POST /api/conversas/:id/sugestao-resposta — rascunho de resposta pro
// atendente revisar (NÃO envia nada ao cliente). Barrado pra AUDITOR (perfil
// somente-leitura) e exige que o recurso esteja ligado em Ajustes
// (config.ia_sugestao_ativa) — desligado por padrão até o admin optar e
// configurar um provedor. Suporte tem o mesmo CRUD de um ADMIN do cliente
// (decisão de produto, FIL-70) — inclusive isto, com o custo do provedor de
// IA coberto pela auditoria central (auth/middleware.js), não por um guard
// de rota. Existiu um `naoSuporte` aqui; foi removido de propósito.
router.post('/:id/sugestao-resposta', naoAuditor, sugestaoIaLimiter, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    // Carrega config/contexto DENTRO da transação, mas devolve a conexão ao
    // pool ANTES de chamar o provedor de IA (a chamada externa pode levar até
    // 45s). Com pool de 10, dez sugestões simultâneas presas em comTenant()
    // esgotariam o pool inteiro e derrubariam o webhook e o resto da API.
    const { config, mensagens } = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }
      // Gate de plano (add-on vendido à parte, só o operador liga — ver
      // operador/tenants.js::definirIa) + gate de recurso (o admin do
      // tenant liga/desliga em Administração → Agente de IA).
      const tenantRow = await conn.execute(`SELECT ia_habilitada FROM tenant WHERE id = :tenantId`, { tenantId: req.tenantId });
      if ((tenantRow.rows[0] || {}).IA_HABILITADA !== 'S') {
        throw new RespostaHttp(400, { error: 'Recurso de IA não incluído no plano desta empresa.' });
      }
      // Teto mensal do add-on (FIL-78): bloqueia ANTES de chamar o provedor,
      // com mensagem clara e SEM expor custo/tokens (ver ia/limitePlano.js).
      if (await limitePlano.estourouTeto(conn, req.tenantId)) {
        throw new RespostaHttp(400, { error: 'Limite mensal de uso de IA atingido para esta empresa. Fale com o Falatta para revisar o plano.' });
      }
      const cfgRow = await conn.execute(`SELECT valor FROM config WHERE chave = 'ia_sugestao_ativa'`);
      if ((cfgRow.rows[0] || {}).VALOR !== 'S') {
        throw new RespostaHttp(400, { error: 'Sugestão de resposta por IA está desativada. Ative em Administração → Agente de IA.' });
      }
      const config = await iaConfigStore.carregar(conn, req.tenantId);
      if (!config) {
        throw new RespostaHttp(400, { error: 'Nenhum provedor de IA configurado. Configure em Administração → Agente de IA.' });
      }
      const mensagens = await sugestaoResposta.carregarContexto(conn, id);
      return { config, mensagens };
    });

    // A conexão JÁ FOI DEVOLVIDA ao pool aqui — a chamada externa roda livre.
    const { texto: sugestao, uso } = await sugestaoResposta.gerarComContexto(config, mensagens);

    // Mede o consumo desta chamada (FIL-77) — só abre uma conexão nova se o
    // provedor realmente devolveu uso; nunca atrasa nem quebra a resposta já
    // gerada (best-effort, ver consumo/registrar.js).
    if (uso && (uso.tokensEntrada > 0 || uso.tokensSaida > 0)) {
      try {
        await db.comTenant(req.tenantId, (conn) => consumo.registrarIaTokens(conn, req.tenantId, {
          tokensEntrada: uso.tokensEntrada, tokensSaida: uso.tokensSaida,
          provider: config.provider, modelo: config.modelo, referencia: id,
        }));
      } catch (err) {
        console.error('[consumo] falha ao registrar consumo da sugestão (não afeta a resposta):', err.message);
      }
    }
    res.json({ sugestao });
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    res.status(502).json({ error: err.message || 'Falha ao gerar sugestão.' });
  }
});

// POST /api/conversas/:id/mensagens — envia TEXTO LIVRE dentro da janela 24h.
// Regras: janela aberta obrigatória (fora dela = só template, fase de campanhas).
// Envia pelo número da conversa (multi-número); fallback = número padrão do .env.
router.post('/:id/mensagens', naoAuditor, envioLimiter, async (req, res, next) => {
  const id = Number(req.params.id);
  const texto = String((req.body && req.body.texto) || '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  if (!texto) return res.status(400).json({ error: 'Texto obrigatório' });
  if (texto.length > 4096) return res.status(400).json({ error: 'Texto excede 4096 caracteres' });

  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }

      // Conversa + contato + número de origem
      const sel = await conn.execute(
        `SELECT c.id, c.contato_id, c.numero_id, c.janela_expira_em, c.departamento_id,
                ct.telefone, n.phone_number_id
           FROM conversa c
           JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
           LEFT JOIN numero n ON n.tenant_id = c.tenant_id AND n.id = c.numero_id
          WHERE c.id = :id`,
        { id }
      );
      if (!sel.rows.length) throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      const cv = sel.rows[0];

      // Janela de 24h: fora dela a Meta rejeita texto livre (só template).
      const expira = cv.JANELA_EXPIRA_EM ? new Date(cv.JANELA_EXPIRA_EM).getTime() : 0;
      if (!expira || expira <= Date.now()) {
        throw new RespostaHttp(409, {
          error: 'Janela de 24h fechada — envio de texto livre indisponível. '
               + 'Aguarde o cliente responder ou use um template (próxima fase).',
        });
      }

      const atendenteId = await getOrCreateAtendente(conn, req.user);
      const atendente = await conn.execute(`SELECT nome FROM atendente WHERE id = :id`, { id: atendenteId });
      const textoEnviado = identificarAtendente(
        (atendente.rows[0] && atendente.rows[0].NOME) || (req.user && req.user.nome),
        texto
      );
      if (textoEnviado.length > 4096) {
        throw new RespostaHttp(400, { error: 'Texto excede o limite após incluir o nome do atendente.' });
      }

      // Envia pela Cloud API (número da conversa; undefined = padrão do .env).
      const resp = await sendText(
        cv.TELEFONE,
        textoEnviado,
        cv.PHONE_NUMBER_ID || undefined,
        req.tenantId
      );
      const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;

      // Persiste a saída no histórico (status evolui via webhook: sent/delivered/read).
      const { tipos } = db;
      const ins = await conn.execute(
        `INSERT INTO mensagem
           (conversa_id, contato_id, numero_id, atendente_id, wamid, direcao, tipo, conteudo, status, ts)
         VALUES (:cv, :ct, :num, :atd, :wamid, 'out', 'text', :txt, 'sent', now())
         RETURNING id INTO :id`,
        {
          cv: cv.ID, ct: cv.CONTATO_ID, num: cv.NUMERO_ID, atd: atendenteId,
          wamid: wamid || null, txt: textoEnviado,
          id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
        }
      );
      await conn.execute(
        `UPDATE conversa
            SET ultima_msg_em = now(),
                primeira_resposta_em = COALESCE(primeira_resposta_em, now())
          WHERE id = :id`,
        { id: cv.ID }
      );

      // Mede o envio (FIL-77) — best-effort, ver consumo/registrar.js.
      await consumo.registrar(conn, req.tenantId, {
        tipo: 'mensagem_enviada', quantidade: 1, referencia: ins.outBinds.id[0],
      });

      return {
        msgId: ins.outBinds.id[0], wamid, conversaId: cv.ID, contatoId: cv.CONTATO_ID,
        departamentoId: cv.DEPARTAMENTO_ID || null, textoEnviado,
      };
    });

    publish({
      tipo: 'mensagem', direcao: 'out', conversaId: resultado.conversaId, contatoId: resultado.contatoId,
      departamentoId: resultado.departamentoId, tenantId: req.tenantId,
    });
    res.status(201).json(mapRow({
      ID: resultado.msgId, DIRECAO: 'out', TIPO: 'text',
      CONTEUDO: resultado.textoEnviado, STATUS: 'sent', WAMID: resultado.wamid, TS: new Date(),
    }));
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    // Erro da Graph API (ex.: 131047 re-engajamento) vira 502 com a mensagem amigável.
    if (err.isGraphError) {
      return res.status(502).json({ error: err.message, codigo: err.graphCode });
    }
    next(err);
  }
});

// POST /api/conversas/:id/arquivos — envia um ARQUIVO pro cliente (como no
// WhatsApp: imagem/áudio/vídeo viram mídia nativa; o resto vai como documento).
// Regra Meta: arquivo é mensagem livre → exige janela de 24h aberta.
const multer = require('multer');
const { storage, storageKey } = require('../storage');
// Allowlist de MIME aceitos no upload (tipos suportados pela Cloud API).
const MIME_PERMITIDOS = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr',
  'video/mp4', 'video/3gpp',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // teto da Meta p/ áudio/vídeo/doc comum
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '').split(';')[0].toLowerCase();
    if (MIME_PERMITIDOS.has(mime)) return cb(null, true);
    const e = new Error('Tipo de arquivo não permitido.');
    e.code = 'MIME_NAO_PERMITIDO';
    cb(e);
  },
});

router.post('/:id/arquivos', naoAuditor, envioLimiter, (req, res, next) => {
  upload.single('arquivo')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo excede 16MB.'
        : err.code === 'MIME_NAO_PERMITIDO' ? err.message : 'Falha no upload do arquivo.';
      return res.status(415).json({ error: msg });
    }
    next();
  });
}, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const { uploadMedia, sendDocument, sendImage, sendAudio, sendVideo, tipoPorMime } = require('../graph/media');
  let caminho = null;
  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }
      const sel = await conn.execute(
        `SELECT c.id, c.contato_id, c.numero_id, c.janela_expira_em, c.departamento_id,
                ct.telefone, n.phone_number_id
           FROM conversa c
           JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
           LEFT JOIN numero n ON n.tenant_id = c.tenant_id AND n.id = c.numero_id
          WHERE c.id = :id`,
        { id }
      );
      if (!sel.rows.length) throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      const cv = sel.rows[0];

      const expira = cv.JANELA_EXPIRA_EM ? new Date(cv.JANELA_EXPIRA_EM).getTime() : 0;
      if (!expira || expira <= Date.now()) {
        throw new RespostaHttp(409, { error: 'Janela de 24h fechada — envio de arquivo indisponível.' });
      }

      // Persiste no storage configurado e sobe o binário pra Meta.
      const nomeOriginal = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const nomeArquivo = `out_${Date.now()}_${nomeOriginal.replace(/[^\w.\-]+/g, '_')}`;
      caminho = storageKey(req.tenantId, cv.ID, nomeArquivo);
      await storage.salvar(req.file.buffer, caminho, req.file.mimetype);

      const mime = req.file.mimetype || 'application/octet-stream';
      const tipo = tipoPorMime(mime);
      const mediaId = await uploadMedia(req.file.buffer, mime, cv.PHONE_NUMBER_ID || undefined, req.tenantId);

      let resp;
      if (tipo === 'image') resp = await sendImage(cv.TELEFONE, { id: mediaId }, cv.PHONE_NUMBER_ID || undefined, req.tenantId);
      else if (tipo === 'audio') resp = await sendAudio(cv.TELEFONE, { id: mediaId }, cv.PHONE_NUMBER_ID || undefined, req.tenantId);
      else if (tipo === 'video') resp = await sendVideo(cv.TELEFONE, { id: mediaId }, cv.PHONE_NUMBER_ID || undefined, req.tenantId);
      else resp = await sendDocument(cv.TELEFONE, { id: mediaId, filename: nomeOriginal }, cv.PHONE_NUMBER_ID || undefined, req.tenantId);
      const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;

      const atendenteId = await getOrCreateAtendente(conn, req.user);
      const { tipos } = db;
      const ins = await conn.execute(
        `INSERT INTO mensagem
           (conversa_id, contato_id, numero_id, atendente_id, wamid, direcao, tipo, status, ts,
            media_id, mime_type, nome_arquivo, midia_caminho, midia_tamanho)
         VALUES (:cv, :ct, :num, :atd, :wamid, 'out', :tipo, 'sent', now(),
            :mid, :mime, :nome, :cam, :tam)
         RETURNING id INTO :id`,
        {
          cv: cv.ID, ct: cv.CONTATO_ID, num: cv.NUMERO_ID, atd: atendenteId,
          wamid: wamid || null, tipo, mid: mediaId, mime,
          nome: nomeOriginal, cam: caminho, tam: req.file.size,
          id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
        }
      );
      await conn.execute(
        `UPDATE conversa
            SET ultima_msg_em = now(),
                primeira_resposta_em = COALESCE(primeira_resposta_em, now())
          WHERE id = :id`,
        { id: cv.ID }
      );

      // Mede o envio E o armazenamento da mídia (FIL-77) — best-effort.
      await consumo.registrar(conn, req.tenantId, {
        tipo: 'mensagem_enviada', quantidade: 1, referencia: ins.outBinds.id[0],
      });
      await consumo.registrar(conn, req.tenantId, {
        tipo: 'midia_armazenada', quantidade: req.file.size, referencia: ins.outBinds.id[0],
      });

      return {
        id: ins.outBinds.id[0], tipo, nomeArquivo: nomeOriginal, wamid,
        conversaId: cv.ID, contatoId: cv.CONTATO_ID, departamentoId: cv.DEPARTAMENTO_ID || null,
      };
    });

    publish({
      tipo: 'mensagem', direcao: 'out', conversaId: resultado.conversaId, contatoId: resultado.contatoId,
      departamentoId: resultado.departamentoId, tenantId: req.tenantId,
    });
    res.status(201).json({ id: resultado.id, tipo: resultado.tipo, nomeArquivo: resultado.nomeArquivo, wamid: resultado.wamid });
  } catch (err) {
    if (caminho) storage.remover(caminho).catch(() => {}); // não deixa lixo se falhou
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    if (err.isGraphError) {
      return res.status(502).json({ error: err.message, codigo: err.graphCode });
    }
    next(err);
  }
});

// POST /api/conversas/:id/notas — nota interna (NÃO vai pro WhatsApp).
// Fica no histórico com DIRECAO='nota' e o atendente como autor.
router.post('/:id/notas', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  const texto = String((req.body && req.body.texto) || '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  if (!texto) return res.status(400).json({ error: 'Texto obrigatório' });
  if (texto.length > 4096) return res.status(400).json({ error: 'Texto excede 4096 caracteres' });

  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }
      const cv = await conn.execute(
        `SELECT contato_id FROM conversa WHERE id = :id`, { id }
      );
      if (!cv.rows.length) throw new RespostaHttp(404, { error: 'Conversa não encontrada' });

      const atendenteId = await getOrCreateAtendente(conn, req.user);
      const { tipos } = db;
      const ins = await conn.execute(
        `INSERT INTO mensagem (conversa_id, contato_id, atendente_id, direcao, tipo, conteudo, ts)
         VALUES (:cv, :ct, :atd, 'nota', 'text', :txt, now())
         RETURNING id INTO :id`,
        {
          cv: id, ct: cv.rows[0].CONTATO_ID, atd: atendenteId, txt: texto,
          id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
        }
      );
      return { msgId: ins.outBinds.id[0] };
    });

    publish({ tipo: 'mensagem', direcao: 'nota', conversaId: id, tenantId: req.tenantId });
    res.status(201).json(mapRow({
      ID: resultado.msgId, DIRECAO: 'nota', TIPO: 'text', CONTEUDO: texto, TS: new Date(),
    }));
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    next(err);
  }
});

// PUT /api/conversas/:id/tags — define as tags (array de IDs) da conversa.
router.put('/:id/tags', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const tags = Array.isArray(req.body && req.body.tags)
    ? req.body.tags.map(Number).filter(Number.isInteger)
    : [];

  try {
    await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }
      const upd = await conn.execute(
        `UPDATE conversa SET tags = :tags WHERE id = :id`,
        { tags: JSON.stringify(tags), id }
      );
      if (!upd.rowsAffected) throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
    });
    publish({ tipo: 'conversa', conversaId: id, tenantId: req.tenantId });
    res.json({ id, tags });
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    next(err);
  }
});

// ─── Ações de ADMIN em LOTE (forçadas) ─────────────────────────────────────
// Furam o escopo do atendente (admin age sobre qualquer conversa) → ADMIN-only e
// auditadas POR conversa. Caminho de uso: redistribuir/encerrar as conversas
// presas de um atendente ausente, em massa, pelo Histórico.

// POST /api/conversas/forcar-transferir — { ids:[], departamentoId? | atendenteId? }
router.post('/forcar-transferir', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  const paraDepto = Number(b.departamentoId) || null;
  const paraAtendente = Number(b.atendenteId) || null;
  if (!ids.length) return res.status(400).json({ error: 'Informe ao menos uma conversa (ids).' });
  if (!paraDepto && !paraAtendente) return res.status(400).json({ error: 'Informe departamentoId ou atendenteId.' });
  if (paraDepto && paraAtendente) return res.status(400).json({ error: 'Escolha departamento OU atendente, não os dois.' });
  if (ids.length > 200) return res.status(400).json({ error: 'No máximo 200 conversas por vez.' });

  const distribuidor = require('../fila/distribuidor');
  const { gerarProtocolo } = require('../fila/protocolo');
  try {
    const { ok, total, erros, eventos, deptosAfetados } = await db.comTenant(req.tenantId, async (conn) => {
      // Valida o destino UMA vez.
      let destinoTxt;
      if (paraDepto) {
        const dep = await conn.execute(`SELECT nome FROM departamento WHERE id = :d AND ativo = 'S'`, { d: paraDepto });
        if (!dep.rows.length) throw new RespostaHttp(400, { error: 'Departamento inválido/inativo.' });
        destinoTxt = `departamento ${dep.rows[0].NOME}`;
      } else {
        const atd = await conn.execute(`SELECT nome FROM atendente WHERE id = :a AND ativo = 'S'`, { a: paraAtendente });
        if (!atd.rows.length) throw new RespostaHttp(400, { error: 'Atendente inválido/inativo.' });
        destinoTxt = `atendente ${atd.rows[0].NOME || paraAtendente}`;
      }
      const autorId = await getOrCreateAtendente(conn, req.user);
      const deptosAfetadosSet = new Set();
      const eventosLocais = [];
      let okCount = 0; const errosLocais = [];
      for (const id of ids) {
        try {
          await comSavepoint(conn, async () => {
            const sel = await conn.execute(
              `SELECT contato_id, departamento_id, atendente_id, protocolo, fila_status, status FROM conversa WHERE id = :id`, { id });
            if (!sel.rows.length) { errosLocais.push({ id, error: 'não encontrada' }); return; }
            const atual = sel.rows[0];
            // Não reabrir conversa já encerrada por engano (a seleção do Histórico pode incluir resolvidas).
            if (atual.FILA_STATUS === 'resolvida' || atual.STATUS === 'resolvida') { errosLocais.push({ id, error: 'já resolvida' }); return; }
            if (paraDepto) {
              const protocolo = atual.PROTOCOLO || await gerarProtocolo(conn);
              await conn.execute(
                `UPDATE conversa SET departamento_id = :d, atendente_id = NULL,
                    fila_status = 'aguardando', fila_entrou_em = now(), protocolo = :prot WHERE id = :id`,
                { d: paraDepto, prot: protocolo, id });
              deptosAfetadosSet.add(paraDepto);
            } else {
              await conn.execute(
                `UPDATE conversa SET atendente_id = :a, fila_status = 'em_atendimento', atribuida_em = now() WHERE id = :id`,
                { a: paraAtendente, id });
            }
            await conn.execute(
              `INSERT INTO mensagem (conversa_id, contato_id, atendente_id, direcao, tipo, conteudo, ts)
               VALUES (:cv, :ct, :atd, 'nota', 'text', :txt, now())`,
              { cv: id, ct: atual.CONTATO_ID, atd: autorId, txt: `Transferência forçada para ${destinoTxt} por ${(req.user && req.user.nome) || 'admin'}.` });
            await conn.execute(
              `INSERT INTO auditoria (atendente_id, matricula, acao, entidade, entidade_id, detalhe)
               VALUES (:atd, :m, 'transferencia', 'conversa', :id, :det)`,
              { atd: autorId, m: req.user && req.user.matricula, id,
                det: JSON.stringify({ forcada: true, deDepto: atual.DEPARTAMENTO_ID, deAtendente: atual.ATENDENTE_ID, paraDepto, paraAtendente }) });
            eventosLocais.push({ tipo: 'transferencia', conversaId: id, departamentoId: atual.DEPARTAMENTO_ID || null });
            if (paraDepto && paraDepto !== atual.DEPARTAMENTO_ID) eventosLocais.push({ tipo: 'transferencia', conversaId: id, departamentoId: paraDepto });
            if (paraAtendente) eventosLocais.push({ tipo: 'transferencia', conversaId: id, atendenteId: paraAtendente, departamentoId: atual.DEPARTAMENTO_ID || null });
            okCount += 1;
          });
        } catch (e) {
          errosLocais.push({ id, error: e.message });
        }
      }
      return { ok: okCount, total: ids.length, erros: errosLocais, eventos: eventosLocais, deptosAfetados: [...deptosAfetadosSet] };
    });
    for (const evt of eventos) publish({ ...evt, tenantId: req.tenantId });
    for (const d of deptosAfetados) distribuidor.atribuir(d);
    res.json({ ok, total, erros });
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    next(err);
  }
});

// POST /api/conversas/forcar-finalizar — { ids:[] }. Marca como resolvida (sem despedida).
router.post('/forcar-finalizar', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) return res.status(400).json({ error: 'Informe ao menos uma conversa (ids).' });
  if (ids.length > 200) return res.status(400).json({ error: 'No máximo 200 conversas por vez.' });

  try {
    const { ok, total, erros, eventos } = await db.comTenant(req.tenantId, async (conn) => {
      const autorId = await getOrCreateAtendente(conn, req.user);
      let okCount = 0; const errosLocais = []; const eventosLocais = [];
      for (const id of ids) {
        try {
          await comSavepoint(conn, async () => {
            const sel = await conn.execute(`SELECT departamento_id, protocolo, fila_status FROM conversa WHERE id = :id`, { id });
            if (!sel.rows.length) { errosLocais.push({ id, error: 'não encontrada' }); return; }
            if (sel.rows[0].FILA_STATUS === 'resolvida') { errosLocais.push({ id, error: 'já resolvida' }); return; }
            await conn.execute(
              `UPDATE conversa SET status = 'resolvida', fila_status = 'resolvida', resolvida_em = now() WHERE id = :id`, { id });
            await conn.execute(
              `INSERT INTO auditoria (atendente_id, matricula, acao, entidade, entidade_id, detalhe)
               VALUES (:atd, :m, 'encerramento', 'conversa', :id, :det)`,
              { atd: autorId, m: req.user && req.user.matricula, id, det: JSON.stringify({ forcada: true, protocolo: sel.rows[0].PROTOCOLO }) });
            eventosLocais.push({ tipo: 'conversa', conversaId: id, departamentoId: sel.rows[0].DEPARTAMENTO_ID || null });
            okCount += 1;
          });
        } catch (e) {
          errosLocais.push({ id, error: e.message });
        }
      }
      return { ok: okCount, total: ids.length, erros: errosLocais, eventos: eventosLocais };
    });
    for (const evt of eventos) publish({ ...evt, tenantId: req.tenantId });
    res.json({ ok, total, erros });
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    next(err);
  }
});

// POST /api/conversas/:id/atribuir — assume a conversa da fila (ou supervisor
// atribui a outro via { atendenteId }). Guard contra corrida: só atribui se
// ainda estiver 'aguardando'.
router.post('/:id/atribuir', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const perfil = req.perfil || {};
  const alvoId = Number((req.body && req.body.atendenteId) || perfil.atendenteId);
  if (!alvoId) return res.status(400).json({ error: 'Atendente não identificado' });
  // Atribuir a TERCEIRO exige gestor.
  if (alvoId !== perfil.atendenteId && !['ADMIN', 'SUPERVISOR'].includes(perfil.papel)) {
    return res.status(403).json({ error: 'Só supervisor/admin atribui a outro atendente' });
  }

  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }
      // Valida o atendente-alvo (existe e está ativo) — espelha o /transferir.
      if (alvoId !== perfil.atendenteId) {
        const alvo = await conn.execute(
          `SELECT 1 FROM atendente WHERE id = :a AND ativo = 'S'`, { a: alvoId });
        if (!alvo.rows.length) throw new RespostaHttp(400, { error: 'Atendente inválido ou inativo.' });
      }
      const upd = await conn.execute(
        `UPDATE conversa
            SET atendente_id = :a, fila_status = 'em_atendimento', atribuida_em = now()
          WHERE id = :id AND fila_status = 'aguardando'`,
        { a: alvoId, id }
      );
      if (!upd.rowsAffected) {
        throw new RespostaHttp(409, { error: 'Conversa já foi atribuída (ou não está aguardando).' });
      }
      const cv = await conn.execute(
        `SELECT departamento_id FROM conversa WHERE id = :id`, { id }
      );
      await conn.execute(
        `INSERT INTO auditoria (atendente_id, matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:atd, :m, 'atribuicao', 'conversa', :id, :det)`,
        { atd: alvoId, m: req.user && req.user.matricula, id, det: JSON.stringify({ por: perfil.atendenteId }) }
      );
      return { departamentoId: cv.rows[0] ? cv.rows[0].DEPARTAMENTO_ID : null };
    });
    publish({
      tipo: 'atribuicao', conversaId: id, atendenteId: alvoId,
      departamentoId: resultado.departamentoId, tenantId: req.tenantId,
    });
    res.json({ ok: true, atendenteId: alvoId });
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    next(err);
  }
});

// POST /api/conversas/:id/transferir — { departamentoId } volta pra fila do
// novo depto (e o distribuidor age); { atendenteId } transfere direto.
router.post('/:id/transferir', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const b = req.body || {};
  const paraDepto = Number(b.departamentoId) || null;
  const paraAtendente = Number(b.atendenteId) || null;
  if (!paraDepto && !paraAtendente) {
    return res.status(400).json({ error: 'Informe departamentoId ou atendenteId' });
  }
  // Direcionar a um ATENDENTE específico é ação de gestor (mesma regra do /atribuir).
  if (paraAtendente && !['ADMIN', 'SUPERVISOR'].includes((req.perfil || {}).papel)) {
    return res.status(403).json({ error: 'Só supervisor/admin transfere direto para um atendente.' });
  }

  const distribuidor = require('../fila/distribuidor');
  const { gerarProtocolo } = require('../fila/protocolo');

  try {
    const { eventos } = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }
      const sel = await conn.execute(
        `SELECT contato_id, departamento_id, atendente_id, protocolo
           FROM conversa WHERE id = :id`, { id }
      );
      if (!sel.rows.length) throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      const atual = sel.rows[0];

      // ATENDENTE só transfere para departamento que ele atende (gestor pode qualquer).
      if (paraDepto && !['ADMIN', 'SUPERVISOR'].includes((req.perfil || {}).papel)
          && !((req.perfil || {}).deptoIds || []).includes(paraDepto)) {
        throw new RespostaHttp(403, { error: 'Você só pode transferir para um departamento que atende.' });
      }

      let destinoTxt;
      if (paraDepto) {
        const dep = await conn.execute(
          `SELECT nome FROM departamento WHERE id = :d AND ativo = 'S'`, { d: paraDepto }
        );
        if (!dep.rows.length) throw new RespostaHttp(400, { error: 'Departamento inválido/inativo' });
        destinoTxt = `departamento ${dep.rows[0].NOME}`;

        // Conversa do inbox geral ganhando depto pela 1ª vez → gera protocolo.
        const protocolo = atual.PROTOCOLO || await gerarProtocolo(conn);
        await conn.execute(
          `UPDATE conversa
              SET departamento_id = :d, atendente_id = NULL,
                  fila_status = 'aguardando', fila_entrou_em = now(),
                  protocolo = :prot
            WHERE id = :id`,
          { d: paraDepto, prot: protocolo, id }
        );
      } else {
        const atd = await conn.execute(
          `SELECT nome FROM atendente WHERE id = :a AND ativo = 'S'`, { a: paraAtendente }
        );
        if (!atd.rows.length) throw new RespostaHttp(400, { error: 'Atendente inválido/inativo' });
        destinoTxt = `atendente ${atd.rows[0].NOME || paraAtendente}`;
        await conn.execute(
          `UPDATE conversa
              SET atendente_id = :a, fila_status = 'em_atendimento', atribuida_em = now()
            WHERE id = :id`,
          { a: paraAtendente, id }
        );
      }

      // Nota interna automática (contexto pro próximo atendente).
      const autorId = await getOrCreateAtendente(conn, req.user);
      await conn.execute(
        `INSERT INTO mensagem (conversa_id, contato_id, atendente_id, direcao, tipo, conteudo, ts)
         VALUES (:cv, :ct, :atd, 'nota', 'text', :txt, now())`,
        {
          cv: id, ct: atual.CONTATO_ID, atd: autorId,
          txt: `Transferida para ${destinoTxt} por ${(req.user && req.user.nome) || 'sistema'}.`,
        }
      );
      await conn.execute(
        `INSERT INTO auditoria (atendente_id, matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:atd, :m, 'transferencia', 'conversa', :id, :det)`,
        {
          atd: autorId, m: req.user && req.user.matricula, id,
          det: JSON.stringify({ deDepto: atual.DEPARTAMENTO_ID, deAtendente: atual.ATENDENTE_ID, paraDepto, paraAtendente }),
        }
      );

      // Notifica os DOIS lados (origem e destino) e aciona o distribuidor.
      const eventosLocais = [{ tipo: 'transferencia', conversaId: id, departamentoId: atual.DEPARTAMENTO_ID || null }];
      if (paraDepto && paraDepto !== atual.DEPARTAMENTO_ID) {
        eventosLocais.push({ tipo: 'transferencia', conversaId: id, departamentoId: paraDepto });
      }
      if (paraAtendente) {
        eventosLocais.push({ tipo: 'transferencia', conversaId: id, atendenteId: paraAtendente, departamentoId: atual.DEPARTAMENTO_ID || null });
      }
      return { eventos: eventosLocais };
    });

    for (const evt of eventos) publish({ ...evt, tenantId: req.tenantId });
    if (paraDepto) distribuidor.atribuir(paraDepto);

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    next(err);
  }
});

// POST /api/conversas/:id/encerrar — finaliza o atendimento { despedida? }.
// Seta STATUS e FILA_STATUS como 'resolvida' (próximo contato = conversa nova).
router.post('/:id/encerrar', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const despedida = String((req.body && req.body.despedida) || '').trim();

  try {
    const resultado = await db.comTenant(req.tenantId, async (conn) => {
      if (!(await conversaNoEscopo(conn, id, req.perfil))) {
        throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      }
      const sel = await conn.execute(
        `SELECT c.contato_id, c.numero_id, c.departamento_id, c.janela_expira_em, c.protocolo,
                ct.telefone, n.phone_number_id
           FROM conversa c
           JOIN contato ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contato_id
           LEFT JOIN numero n ON n.tenant_id = c.tenant_id AND n.id = c.numero_id
          WHERE c.id = :id`,
        { id }
      );
      if (!sel.rows.length) throw new RespostaHttp(404, { error: 'Conversa não encontrada' });
      const cv = sel.rows[0];

      // Despedida (opcional, só com janela aberta) — falha não impede o encerramento.
      const atendenteId = await getOrCreateAtendente(conn, req.user);
      const atd = await conn.execute(`SELECT nome FROM atendente WHERE id = :id`, { id: atendenteId });
      const despedidaIdentificada = despedida
        ? identificarAtendente((atd.rows[0] && atd.rows[0].NOME) || (req.user && req.user.nome), despedida)
        : '';
      const expira = cv.JANELA_EXPIRA_EM ? new Date(cv.JANELA_EXPIRA_EM).getTime() : 0;
      if (despedidaIdentificada && expira > Date.now()) {
        try {
          const resp = await sendText(
            cv.TELEFONE,
            despedidaIdentificada,
            cv.PHONE_NUMBER_ID || undefined,
            req.tenantId
          );
          const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
          await conn.execute(
            `INSERT INTO mensagem
               (conversa_id, contato_id, numero_id, atendente_id, wamid, direcao, tipo, conteudo, status, ts)
             VALUES (:cv, :ct, :num, :atd, :wamid, 'out', 'text', :txt, 'sent', now())`,
            {
              cv: id,
              ct: cv.CONTATO_ID,
              num: cv.NUMERO_ID,
              atd: atendenteId,
              wamid: wamid || null,
              txt: despedidaIdentificada,
            }
          );
        } catch (e) {
          console.error('[conversas] despedida falhou (encerrando mesmo assim):', e.message);
        }
      }

      await conn.execute(
        `UPDATE conversa
            SET status = 'resolvida', fila_status = 'resolvida', resolvida_em = now()
          WHERE id = :id`,
        { id }
      );
      await conn.execute(
        `INSERT INTO auditoria (atendente_id, matricula, acao, entidade, entidade_id, detalhe)
         VALUES (:atd, :m, 'encerramento', 'conversa', :id, :det)`,
        { atd: atendenteId, m: req.user && req.user.matricula, id, det: JSON.stringify({ protocolo: cv.PROTOCOLO }) }
      );
      return { departamentoId: cv.DEPARTAMENTO_ID || null };
    });

    publish({ tipo: 'conversa', conversaId: id, departamentoId: resultado.departamentoId, tenantId: req.tenantId });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof RespostaHttp) return res.status(err.status).json(err.body);
    next(err);
  }
});

module.exports = router;
