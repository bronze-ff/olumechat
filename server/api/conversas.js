// api/conversas.js — Lista de conversas, mensagens e ENVIO (Fase 2).
// Leitura vem do que o webhook gravou; o envio usa o número da própria
// conversa (multi-número via MC_ZAP_NUMERO) e persiste a saída no histórico.
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

const router = express.Router();

/** Bloqueia AUDITOR (papel SOMENTE-LEITURA) nas rotas de mutação. ADMIN/SUPERVISOR/
    ATENDENTE seguem; demais checagens (escopo, podeAtivo, gestor) continuam valendo. */
function naoAuditor(req, res, next) {
  if (req.perfil && req.perfil.papel === 'AUDITOR') {
    return res.status(403).json({ error: 'Perfil somente-leitura (AUDITOR) não pode executar esta ação.' });
  }
  next();
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
    `SELECT ID, DEPARTAMENTO_ID, NUMERO_ID, ATENDENTE_ID FROM MC_ZAP_CONVERSA WHERE ID = :id`,
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

/** Acha/cria contato por telefone (casa variantes do 9º dígito); atualiza CODCLI. */
async function getOrCreateContato(conn, telefone, codcli) {
  const { tipos } = db;
  const achado = await acharContato(conn, telefone);
  if (achado) {
    const id = achado.ID;
    if (codcli) {
      await conn.execute(
        `UPDATE MC_ZAP_CONTATO SET CODCLI = :c WHERE ID = :id AND CODCLI IS NULL`,
        { c: codcli, id }
      );
    }
    return id;
  }
  // Auto-identificação (igual ao receptivo): sem CODCLI informado, casa o telefone
  // com o PCCLIENT e já preenche CODCLI + CNPJ + nome interno (razão social).
  let cli = null;
  if (!codcli) { try { cli = await acharClientePorTelefone(conn, telefone); } catch { cli = null; } }
  const ins = await conn.execute(
    `INSERT INTO MC_ZAP_CONTATO (TELEFONE, CODCLI, CGCENT, NOME_INTERNO)
     VALUES (:tel, :cod, :cgc, :ni) RETURNING ID INTO :id`,
    { tel: telefone,
      cod: codcli || (cli ? cli.codcli : null),
      cgc: cli ? cli.cgcent : null,
      ni: cli ? cli.nome : null,
      id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
  );
  return ins.outBinds.id[0];
}

/** Garante o atendente (por matrícula do JWT) e devolve o ID. */
async function getOrCreateAtendente(conn, user) {
  if (!user || !user.matricula) return null;
  const sel = await conn.execute(
    `SELECT ID FROM MC_ZAP_ATENDENTE WHERE MATRICULA = :m`,
    { m: user.matricula }
  );
  if (sel.rows.length) return sel.rows[0].ID;
  const { tipos } = db;
  const ins = await conn.execute(
    `INSERT INTO MC_ZAP_ATENDENTE (MATRICULA, NOME) VALUES (:m, :n)
     RETURNING ID INTO :id`,
    { m: user.matricula, n: user.nome || null, id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
  );
  return ins.outBinds.id[0];
}

// POST /api/conversas — INICIA contato (fora da janela 24h → via template).
// body: { telefone, codcli?, templateName, lang?, variaveis?[], preview? }
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

  let conn;
  try {
    conn = await db.getConnection();
    const contatoId = await getOrCreateContato(conn, telefone, b.codcli ? Number(b.codcli) : null);

    // Opt-out (LGPD): bloqueia se a ação MAIS RECENTE do contato for 'optout'
    // (assim um "VOLTAR" posterior reabilita o disparo).
    const opt = await conn.execute(
      `SELECT ACAO FROM MC_ZAP_AUDITORIA
        WHERE ENTIDADE = 'contato' AND ENTIDADE_ID = :id AND ACAO IN ('optin', 'optout')
        ORDER BY CRIADO_EM DESC, ID DESC FETCH FIRST 1 ROWS ONLY`,
      { id: contatoId }
    );
    if (opt.rows.length && opt.rows[0].ACAO === 'optout') {
      return res.status(409).json({ error: 'Cliente optou por não receber mensagens ("PARAR").' });
    }

    // Número de origem: o escolhido na tela (numeroId) ou o padrão do .env.
    // Só números com PERMITE_ATIVO='S' podem originar conversa ativa — assim o
    // número receptivo (ex.: 1090, com fluxo) fica fora do disparo manual.
    let numeroId = null;
    let phoneNumberIdEnvio; // undefined = padrão do .env
    let deptoPadraoNumero = null; // departamento padrão configurado no número
    const numSel = b.numeroId
      ? await conn.execute(
          `SELECT ID, PHONE_NUMBER_ID, PERMITE_ATIVO, ATIVO, DEPARTAMENTO_PADRAO_ID FROM MC_ZAP_NUMERO WHERE ID = :id`,
          { id: Number(b.numeroId) })
      : await conn.execute(
          `SELECT ID, PHONE_NUMBER_ID, PERMITE_ATIVO, ATIVO, DEPARTAMENTO_PADRAO_ID FROM MC_ZAP_NUMERO WHERE PHONE_NUMBER_ID = :p`,
          { p: cfg.phoneNumberId });
    if (b.numeroId && !numSel.rows.length) {
      return res.status(400).json({ error: 'Número de origem não encontrado.' });
    }
    if (numSel.rows.length) {
      const num = numSel.rows[0];
      if (num.ATIVO === 'N') return res.status(409).json({ error: 'Esse número está inativo.' });
      if (num.PERMITE_ATIVO === 'N') {
        return res.status(409).json({ error: 'Esse número não permite conversa ativa. Escolha um número habilitado (Admin → Números).' });
      }
      // Acesso por número: atendente restrito só envia pelos números dele.
      const meusNum = (req.perfil && req.perfil.numeroIds) || [];
      if (meusNum.length && !meusNum.includes(num.ID)) {
        return res.status(403).json({ error: 'Você não tem acesso a esse número de origem.' });
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
        `SELECT ID FROM MC_ZAP_DEPARTAMENTO WHERE ID = :id AND ATIVO = 'S'`, { id: departamentoId });
      if (!dch.rows.length) return res.status(400).json({ error: 'Departamento inválido.' });
      // Escopo: atendente restrito só direciona para um departamento seu.
      const ehAmplo = req.perfil.papel === 'ADMIN' || req.perfil.papel === 'SUPERVISOR';
      const meusDep = req.perfil.deptoIds || [];
      if (!ehAmplo && meusDep.length && !meusDep.includes(departamentoId)) {
        return res.status(403).json({ error: 'Você não tem acesso a esse departamento.' });
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
      `SELECT ID FROM MC_ZAP_CONVERSA WHERE CONTATO_ID = :c AND STATUS <> 'resolvida'
        ORDER BY CRIADO_EM DESC FETCH FIRST 1 ROWS ONLY`, { c: contatoId }
    );
    if (cv.rows.length) {
      conversaId = cv.rows[0].ID;
      // Reaproveitada: só preenche o departamento se ainda estiver sem (COALESCE
      // preserva uma fila já atribuída; não "rouba" a conversa de outra área).
      if (departamentoId) {
        await conn.execute(
          `UPDATE MC_ZAP_CONVERSA
              SET ULTIMA_MSG_EM = SYSTIMESTAMP, DEPARTAMENTO_ID = COALESCE(DEPARTAMENTO_ID, :dep)
            WHERE ID = :id`,
          { dep: departamentoId, id: conversaId });
      } else {
        await conn.execute(`UPDATE MC_ZAP_CONVERSA SET ULTIMA_MSG_EM = SYSTIMESTAMP WHERE ID = :id`, { id: conversaId });
      }
    } else {
      const { gerarProtocolo } = require('../fila/protocolo');
      const protocolo = await gerarProtocolo(conn);
      const insC = await conn.execute(
        `INSERT INTO MC_ZAP_CONVERSA
           (CONTATO_ID, NUMERO_ID, DEPARTAMENTO_ID, ATENDENTE_ID, STATUS, FILA_STATUS, ORIGEM, PROTOCOLO,
            ULTIMA_MSG_EM, ATRIBUIDA_EM)
         VALUES (:c, :n, :dep, :atd, 'aberta', 'em_atendimento', 'ativa', :prot,
            SYSTIMESTAMP, SYSTIMESTAMP) RETURNING ID INTO :id`,
        { c: contatoId, n: numeroId, dep: departamentoId, atd: atendenteId, prot: protocolo,
          id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
      );
      conversaId = insC.outBinds.id[0];
    }
    const conteudo = b.preview ? String(b.preview) : `[template: ${templateName}]`;
    await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM
         (CONVERSA_ID, CONTATO_ID, NUMERO_ID, ATENDENTE_ID, WAMID, DIRECAO, TIPO, CONTEUDO, STATUS, TS)
       VALUES (:cv, :ct, :num, :atd, :wamid, 'out', 'template', :txt, 'sent', SYSTIMESTAMP)`,
      { cv: conversaId, ct: contatoId, num: numeroId, atd: atendenteId, wamid: wamid || null, txt: conteudo }
    );
    await conn.commit();
    publish({ tipo: 'mensagem', direcao: 'out', conversaId, contatoId, departamentoId: departamentoId || null });

    res.status(201).json({ id: conversaId, contatoId, telefone, departamentoId: departamentoId || null, wamid });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err.isGraphError) {
      return res.status(502).json({ error: err.message, codigo: err.graphCode });
    }
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/conversas — lista com contato + última mensagem (Fase 5B: escopo
// por perfil e filtros de fila).
// Query: ?q= (nome/telefone/CODCLI/protocolo) · ?fila= · ?departamentoId= · ?minhas=1
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
  let conn;
  try {
    conn = await db.getConnection();
    const binds = {};
    const conds = [];
    if (q) {
      conds.push(`(UPPER(ct.NOME_PERFIL) LIKE UPPER('%'||:q||'%')
                   OR ct.TELEFONE LIKE '%'||:qd||'%'
                   OR TO_CHAR(ct.CODCLI) = :qc
                   OR c.PROTOCOLO = :qp)`);
      binds.q = q;
      binds.qd = q.replace(/\D/g, '') || ' ';
      binds.qc = q.replace(/\D/g, '') || ' ';
      binds.qp = q.replace(/\D/g, '') || ' ';
    }
    if (['aguardando', 'em_atendimento', 'resolvida', 'bot', 'ia'].includes(fila)) {
      conds.push(`c.FILA_STATUS = :fila`);
      binds.fila = fila;
    }
    if (departamentoId) {
      conds.push(`c.DEPARTAMENTO_ID = :depFiltro`);
      binds.depFiltro = departamentoId;
    }
    if (minhas && perfil.atendenteId) {
      conds.push(`c.ATENDENTE_ID = :meuId`);
      binds.meuId = perfil.atendenteId;
    }
    if (origem) {
      conds.push(`c.ORIGEM = :origem`);
      binds.origem = origem;
    }
    // Janela de 24h: aberta = ainda dá texto livre; fechada = nunca abriu OU expirou.
    // A janela só faz sentido para atendimentos ABERTOS: um encerrado não é
    // respondável (nova mensagem abre outro atendimento), então os filtros de
    // janela ignoram resolvidas — salvo quando o usuário está na aba Resolvidas
    // (aí o filtro age dentro delas, em vez de zerar a lista).
    if (janela) {
      if (janela === 'aberta') {
        conds.push(`c.JANELA_EXPIRA_EM > SYSTIMESTAMP`);
      } else {
        conds.push(`(c.JANELA_EXPIRA_EM IS NULL OR c.JANELA_EXPIRA_EM <= SYSTIMESTAMP)`);
      }
      if (fila !== 'resolvida') conds.push(`c.FILA_STATUS <> 'resolvida'`);
    }
    if (numeroFiltro) {
      conds.push(`c.NUMERO_ID = :numFiltro`);
      binds.numFiltro = numeroFiltro;
    }
    if (naoAtribuida) {
      conds.push(`c.ATENDENTE_ID IS NULL`);
    }
    // Escopo por papel.
    if (perfil.papel !== 'ADMIN' && perfil.papel !== 'AUDITOR') {
      // Visibilidade exclusiva: o ATENDENTE comum só vê a conversa atribuída a
      // ELE ou ainda SEM dono (na fila). Chat já atribuído a um colega some da
      // lista. GESTOR (SUPERVISOR) continua vendo TODO o departamento, para
      // supervisão (ADMIN/AUDITOR nem entram aqui — veem tudo).
      const semDono = perfil.papel === 'SUPERVISOR' ? '' : ` AND c.ATENDENTE_ID IS NULL`;
      const partes = [`(c.DEPARTAMENTO_ID IS NULL${semDono})`];
      if (perfil.atendenteId) {
        partes.push(`c.ATENDENTE_ID = :escopoAtd`);
        binds.escopoAtd = perfil.atendenteId;
      }
      if (perfil.deptoIds.length) {
        const ms = perfil.deptoIds.map((d, i) => { binds[`escDep${i}`] = d; return `:escDep${i}`; });
        partes.push(`(c.DEPARTAMENTO_ID IN (${ms.join(',')})${semDono})`);
      }
      conds.push(`(${partes.join(' OR ')})`);

      // Escopo por NÚMERO (canal): se o atendente tem números cadastrados, só vê
      // conversas desses números (+ sem número + as atribuídas a ele). Lista
      // vazia = sem restrição. Separa ativo (1061) de receptivo (1090) na fila.
      if (perfil.numeroIds && perfil.numeroIds.length) {
        const partesNum = [`c.NUMERO_ID IS NULL`];
        const ns = perfil.numeroIds.map((n, i) => { binds[`escNum${i}`] = n; return `:escNum${i}`; });
        partesNum.push(`c.NUMERO_ID IN (${ns.join(',')})`);
        if (perfil.atendenteId) partesNum.push(`c.ATENDENTE_ID = :escopoAtd`); // já bindado acima
        conds.push(`(${partesNum.join(' OR ')})`);
      }
    }
    const filtro = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const result = await conn.execute(
      `SELECT * FROM (
         SELECT c.ID, c.STATUS, c.JANELA_EXPIRA_EM, c.ULTIMA_MSG_EM, c.NUMERO_ID, c.TAGS,
                c.FILA_STATUS, c.PROTOCOLO, c.DEPARTAMENTO_ID, c.ATENDENTE_ID, c.ORIGEM,
                ct.ID AS CONTATO_ID, ct.TELEFONE, ct.NOME_PERFIL, ct.NOME_INTERNO, ct.CGCENT, ct.CODCLI,
                a.NOME AS ATENDENTE_NOME,
                d.NOME AS DEPARTAMENTO_NOME, d.COR AS DEPARTAMENTO_COR,
                n.NOME_EXIBICAO AS NUMERO_NOME, n.DISPLAY_PHONE AS NUMERO_FONE,
                (SELECT m.CONTEUDO FROM (
                   SELECT CONTEUDO FROM MC_ZAP_MENSAGEM mm
                    WHERE mm.CONVERSA_ID = c.ID
                    ORDER BY mm.TS DESC NULLS LAST, mm.ID DESC
                 ) m WHERE ROWNUM = 1) AS ULTIMA_MSG
           FROM MC_ZAP_CONVERSA c
           JOIN MC_ZAP_CONTATO ct ON ct.ID = c.CONTATO_ID
           LEFT JOIN MC_ZAP_ATENDENTE a ON a.ID = c.ATENDENTE_ID
           LEFT JOIN MC_ZAP_DEPARTAMENTO d ON d.ID = c.DEPARTAMENTO_ID
           LEFT JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
          ${filtro}
          ORDER BY c.ULTIMA_MSG_EM DESC NULLS LAST, c.ID DESC
       ) WHERE ROWNUM <= 100`,
      binds
    );
    // TAGS é JSON (array de IDs) — devolve já parseado.
    const rows = mapRows(result.rows).map((r) => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : [],
      ultimaMsg: r.ultimaMsg,
      nomePerfil: r.nomePerfil,
      nomeInterno: r.nomeInterno,
    }));
    res.json(rows);
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/conversas/contagens — contagem REAL (COUNT no banco) por departamento
// e por atendente, SEM o teto de 100 linhas da listagem. A listagem (GET /) corta
// em ROWNUM<=100, então o Monitor, que contava em cima dela, subcontava (mostrava
// 100 com 118 reais). Aqui o número é exato. Gestor-only, visão global (como o
// /presenca, que já devolve a equipe inteira sem escopo).
router.get('/contagens', exigirPapel('ADMIN', 'SUPERVISOR'), async (req, res, next) => {
  let conn;
  try {
    conn = await db.getConnection();
    const porDep = await conn.execute(
      `SELECT NVL(DEPARTAMENTO_ID, 0) AS DEP, FILA_STATUS, COUNT(*) AS QTD
         FROM MC_ZAP_CONVERSA
        WHERE FILA_STATUS IN ('aguardando', 'em_atendimento')
        GROUP BY NVL(DEPARTAMENTO_ID, 0), FILA_STATUS`,
      {}
    );
    const porAtd = await conn.execute(
      `SELECT ATENDENTE_ID AS ATD, COUNT(*) AS QTD
         FROM MC_ZAP_CONVERSA
        WHERE FILA_STATUS = 'em_atendimento' AND ATENDENTE_ID IS NOT NULL
        GROUP BY ATENDENTE_ID`,
      {}
    );
    const porDepartamento = {};
    for (const r of mapRows(porDep.rows)) {
      if (!porDepartamento[r.dep]) porDepartamento[r.dep] = { aguardando: 0, em_atendimento: 0 };
      porDepartamento[r.dep][r.filaStatus] = r.qtd;
    }
    const porAtendente = {};
    for (const r of mapRows(porAtd.rows)) porAtendente[r.atd] = r.qtd;
    res.json({ porDepartamento, porAtendente });
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// GET /api/conversas/:id/mensagens — thread completa (ordem cronológica).
router.get('/:id/mensagens', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await db.getConnection();
    if (!(await conversaNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    const result = await conn.execute(
      `SELECT ID, DIRECAO, TIPO, CONTEUDO, STATUS, TS,
              MEDIA_ID, MIME_TYPE, NOME_ARQUIVO,
              CASE WHEN MIDIA_CAMINHO IS NOT NULL THEN 1 ELSE 0 END AS TEM_ARQUIVO
         FROM MC_ZAP_MENSAGEM
        WHERE CONVERSA_ID = :id
        ORDER BY TS ASC NULLS LAST, ID ASC`,
      { id }
    );
    res.json(mapRows(result.rows));
  } catch (err) {
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/conversas/:id/mensagens — envia TEXTO LIVRE dentro da janela 24h.
// Regras: janela aberta obrigatória (fora dela = só template, fase de campanhas).
// Envia pelo número da conversa (multi-número); fallback = número padrão do .env.
router.post('/:id/mensagens', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  const texto = String((req.body && req.body.texto) || '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  if (!texto) return res.status(400).json({ error: 'Texto obrigatório' });
  if (texto.length > 4096) return res.status(400).json({ error: 'Texto excede 4096 caracteres' });

  let conn;
  try {
    conn = await db.getConnection();
    if (!(await conversaNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }

    // Conversa + contato + número de origem
    const sel = await conn.execute(
      `SELECT c.ID, c.CONTATO_ID, c.NUMERO_ID, c.JANELA_EXPIRA_EM, c.DEPARTAMENTO_ID,
              ct.TELEFONE, n.PHONE_NUMBER_ID
         FROM MC_ZAP_CONVERSA c
         JOIN MC_ZAP_CONTATO ct ON ct.ID = c.CONTATO_ID
         LEFT JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
        WHERE c.ID = :id`,
      { id }
    );
    if (!sel.rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    const cv = sel.rows[0];

    // Janela de 24h: fora dela a Meta rejeita texto livre (só template).
    const expira = cv.JANELA_EXPIRA_EM ? new Date(cv.JANELA_EXPIRA_EM).getTime() : 0;
    if (!expira || expira <= Date.now()) {
      return res.status(409).json({
        error: 'Janela de 24h fechada — envio de texto livre indisponível. '
             + 'Aguarde o cliente responder ou use um template (próxima fase).',
      });
    }

    // Envia pela Cloud API (número da conversa; undefined = padrão do .env).
    const resp = await sendText(cv.TELEFONE, texto, cv.PHONE_NUMBER_ID || undefined);
    const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;

    // Persiste a saída no histórico (status evolui via webhook: sent/delivered/read).
    const atendenteId = await getOrCreateAtendente(conn, req.user);
    const { tipos } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM
         (CONVERSA_ID, CONTATO_ID, NUMERO_ID, ATENDENTE_ID, WAMID, DIRECAO, TIPO, CONTEUDO, STATUS, TS)
       VALUES (:cv, :ct, :num, :atd, :wamid, 'out', 'text', :txt, 'sent', SYSTIMESTAMP)
       RETURNING ID INTO :id`,
      {
        cv: cv.ID, ct: cv.CONTATO_ID, num: cv.NUMERO_ID, atd: atendenteId,
        wamid: wamid || null, txt: texto,
        id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
      }
    );
    await conn.execute(
      `UPDATE MC_ZAP_CONVERSA
          SET ULTIMA_MSG_EM = SYSTIMESTAMP,
              PRIMEIRA_RESPOSTA_EM = COALESCE(PRIMEIRA_RESPOSTA_EM, SYSTIMESTAMP)
        WHERE ID = :id`,
      { id: cv.ID }
    );
    await conn.commit();
    publish({
      tipo: 'mensagem', direcao: 'out', conversaId: cv.ID, contatoId: cv.CONTATO_ID,
      departamentoId: cv.DEPARTAMENTO_ID || null,
    });

    res.status(201).json(mapRow({
      ID: ins.outBinds.id[0], DIRECAO: 'out', TIPO: 'text',
      CONTEUDO: texto, STATUS: 'sent', WAMID: wamid, TS: new Date(),
    }));
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    // Erro da Graph API (ex.: 131047 re-engajamento) vira 502 com a mensagem amigável.
    if (err.isGraphError) {
      return res.status(502).json({ error: err.message, codigo: err.graphCode });
    }
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/conversas/:id/arquivos — envia um ARQUIVO pro cliente (como no
// WhatsApp: imagem/áudio/vídeo viram mídia nativa; o resto vai como documento).
// Regra Meta: arquivo é mensagem livre → exige janela de 24h aberta.
const multer = require('multer');
const fs = require('fs');
const path = require('path');
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

router.post('/:id/arquivos', naoAuditor, (req, res, next) => {
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
  const { cfg: cfgGraph } = require('../graph/client');

  let conn;
  let caminho = null;
  try {
    conn = await db.getConnection();
    if (!(await conversaNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    const sel = await conn.execute(
      `SELECT c.ID, c.CONTATO_ID, c.NUMERO_ID, c.JANELA_EXPIRA_EM, c.DEPARTAMENTO_ID,
              ct.TELEFONE, n.PHONE_NUMBER_ID
         FROM MC_ZAP_CONVERSA c
         JOIN MC_ZAP_CONTATO ct ON ct.ID = c.CONTATO_ID
         LEFT JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
        WHERE c.ID = :id`,
      { id }
    );
    if (!sel.rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    const cv = sel.rows[0];

    const expira = cv.JANELA_EXPIRA_EM ? new Date(cv.JANELA_EXPIRA_EM).getTime() : 0;
    if (!expira || expira <= Date.now()) {
      return res.status(409).json({ error: 'Janela de 24h fechada — envio de arquivo indisponível.' });
    }

    // Grava no MEDIA_DIR (mesmo lugar dos recebidos) e sobe pra Meta.
    const nomeOriginal = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    fs.mkdirSync(cfgGraph.mediaDir, { recursive: true });
    const nomeArquivo = `out_${Date.now()}_${nomeOriginal.replace(/[^\w.\-]+/g, '_')}`;
    caminho = path.join(cfgGraph.mediaDir, nomeArquivo);
    fs.writeFileSync(caminho, req.file.buffer);

    const mime = req.file.mimetype || 'application/octet-stream';
    const tipo = tipoPorMime(mime);
    const mediaId = await uploadMedia(caminho, mime, cv.PHONE_NUMBER_ID || undefined);

    let resp;
    if (tipo === 'image') resp = await sendImage(cv.TELEFONE, { id: mediaId }, cv.PHONE_NUMBER_ID || undefined);
    else if (tipo === 'audio') resp = await sendAudio(cv.TELEFONE, { id: mediaId }, cv.PHONE_NUMBER_ID || undefined);
    else if (tipo === 'video') resp = await sendVideo(cv.TELEFONE, { id: mediaId }, cv.PHONE_NUMBER_ID || undefined);
    else resp = await sendDocument(cv.TELEFONE, { id: mediaId, filename: nomeOriginal }, cv.PHONE_NUMBER_ID || undefined);
    const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;

    const atendenteId = await getOrCreateAtendente(conn, req.user);
    const { tipos } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM
         (CONVERSA_ID, CONTATO_ID, NUMERO_ID, ATENDENTE_ID, WAMID, DIRECAO, TIPO, STATUS, TS,
          MEDIA_ID, MIME_TYPE, NOME_ARQUIVO, MIDIA_CAMINHO, MIDIA_TAMANHO)
       VALUES (:cv, :ct, :num, :atd, :wamid, 'out', :tipo, 'sent', SYSTIMESTAMP,
          :mid, :mime, :nome, :cam, :tam)
       RETURNING ID INTO :id`,
      {
        cv: cv.ID, ct: cv.CONTATO_ID, num: cv.NUMERO_ID, atd: atendenteId,
        wamid: wamid || null, tipo, mid: mediaId, mime,
        nome: nomeOriginal, cam: caminho, tam: req.file.size,
        id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
      }
    );
    await conn.execute(
      `UPDATE MC_ZAP_CONVERSA
          SET ULTIMA_MSG_EM = SYSTIMESTAMP,
              PRIMEIRA_RESPOSTA_EM = COALESCE(PRIMEIRA_RESPOSTA_EM, SYSTIMESTAMP)
        WHERE ID = :id`,
      { id: cv.ID }
    );
    await conn.commit();
    publish({
      tipo: 'mensagem', direcao: 'out', conversaId: cv.ID, contatoId: cv.CONTATO_ID,
      departamentoId: cv.DEPARTAMENTO_ID || null,
    });

    res.status(201).json({ id: ins.outBinds.id[0], tipo, nomeArquivo: nomeOriginal, wamid });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (caminho) fs.unlink(caminho, () => {}); // não deixa lixo se falhou
    if (err.isGraphError) {
      return res.status(502).json({ error: err.message, codigo: err.graphCode });
    }
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
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

  let conn;
  try {
    conn = await db.getConnection();
    if (!(await conversaNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    const cv = await conn.execute(
      `SELECT CONTATO_ID FROM MC_ZAP_CONVERSA WHERE ID = :id`, { id }
    );
    if (!cv.rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });

    const atendenteId = await getOrCreateAtendente(conn, req.user);
    const { tipos } = db;
    const ins = await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM (CONVERSA_ID, CONTATO_ID, ATENDENTE_ID, DIRECAO, TIPO, CONTEUDO, TS)
       VALUES (:cv, :ct, :atd, 'nota', 'text', :txt, SYSTIMESTAMP)
       RETURNING ID INTO :id`,
      {
        cv: id, ct: cv.rows[0].CONTATO_ID, atd: atendenteId, txt: texto,
        id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
      }
    );
    await conn.commit();
    publish({ tipo: 'mensagem', direcao: 'nota', conversaId: id });

    res.status(201).json(mapRow({
      ID: ins.outBinds.id[0], DIRECAO: 'nota', TIPO: 'text', CONTEUDO: texto, TS: new Date(),
    }));
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// PUT /api/conversas/:id/tags — define as tags (array de IDs) da conversa.
router.put('/:id/tags', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const tags = Array.isArray(req.body && req.body.tags)
    ? req.body.tags.map(Number).filter(Number.isInteger)
    : [];

  let conn;
  try {
    conn = await db.getConnection();
    if (!(await conversaNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    const upd = await conn.execute(
      `UPDATE MC_ZAP_CONVERSA SET TAGS = :tags WHERE ID = :id`,
      { tags: JSON.stringify(tags), id }
    );
    if (!upd.rowsAffected) return res.status(404).json({ error: 'Conversa não encontrada' });
    await conn.commit();
    publish({ tipo: 'conversa', conversaId: id });
    res.json({ id, tags });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
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
  let conn;
  try {
    conn = await db.getConnection();
    // Valida o destino UMA vez.
    let destinoTxt;
    if (paraDepto) {
      const dep = await conn.execute(`SELECT NOME FROM MC_ZAP_DEPARTAMENTO WHERE ID = :d AND ATIVO = 'S'`, { d: paraDepto });
      if (!dep.rows.length) return res.status(400).json({ error: 'Departamento inválido/inativo.' });
      destinoTxt = `departamento ${dep.rows[0].NOME}`;
    } else {
      const atd = await conn.execute(`SELECT NOME FROM MC_ZAP_ATENDENTE WHERE ID = :a AND ATIVO = 'S'`, { a: paraAtendente });
      if (!atd.rows.length) return res.status(400).json({ error: 'Atendente inválido/inativo.' });
      destinoTxt = `atendente ${atd.rows[0].NOME || paraAtendente}`;
    }
    const autorId = await getOrCreateAtendente(conn, req.user);
    const deptosAfetados = new Set();
    let ok = 0; const erros = [];
    for (const id of ids) {
      try {
        const sel = await conn.execute(
          `SELECT CONTATO_ID, DEPARTAMENTO_ID, ATENDENTE_ID, PROTOCOLO, FILA_STATUS, STATUS FROM MC_ZAP_CONVERSA WHERE ID = :id`, { id });
        if (!sel.rows.length) { erros.push({ id, error: 'não encontrada' }); continue; }
        const atual = sel.rows[0];
        // Não reabrir conversa já encerrada por engano (a seleção do Histórico pode incluir resolvidas).
        if (atual.FILA_STATUS === 'resolvida' || atual.STATUS === 'resolvida') { erros.push({ id, error: 'já resolvida' }); continue; }
        if (paraDepto) {
          const protocolo = atual.PROTOCOLO || await gerarProtocolo(conn);
          await conn.execute(
            `UPDATE MC_ZAP_CONVERSA SET DEPARTAMENTO_ID = :d, ATENDENTE_ID = NULL,
                FILA_STATUS = 'aguardando', FILA_ENTROU_EM = SYSTIMESTAMP, PROTOCOLO = :prot WHERE ID = :id`,
            { d: paraDepto, prot: protocolo, id });
          deptosAfetados.add(paraDepto);
        } else {
          await conn.execute(
            `UPDATE MC_ZAP_CONVERSA SET ATENDENTE_ID = :a, FILA_STATUS = 'em_atendimento', ATRIBUIDA_EM = SYSTIMESTAMP WHERE ID = :id`,
            { a: paraAtendente, id });
        }
        await conn.execute(
          `INSERT INTO MC_ZAP_MENSAGEM (CONVERSA_ID, CONTATO_ID, ATENDENTE_ID, DIRECAO, TIPO, CONTEUDO, TS)
           VALUES (:cv, :ct, :atd, 'nota', 'text', :txt, SYSTIMESTAMP)`,
          { cv: id, ct: atual.CONTATO_ID, atd: autorId, txt: `Transferência forçada para ${destinoTxt} por ${(req.user && req.user.nome) || 'admin'}.` });
        await conn.execute(
          `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
           VALUES (:atd, :m, 'transferencia', 'conversa', :id, :det)`,
          { atd: autorId, m: req.user && req.user.matricula, id,
            det: JSON.stringify({ forcada: true, deDepto: atual.DEPARTAMENTO_ID, deAtendente: atual.ATENDENTE_ID, paraDepto, paraAtendente }) });
        await conn.commit();
        publish({ tipo: 'transferencia', conversaId: id, departamentoId: atual.DEPARTAMENTO_ID || null });
        if (paraDepto && paraDepto !== atual.DEPARTAMENTO_ID) publish({ tipo: 'transferencia', conversaId: id, departamentoId: paraDepto });
        if (paraAtendente) publish({ tipo: 'transferencia', conversaId: id, atendenteId: paraAtendente, departamentoId: atual.DEPARTAMENTO_ID || null });
        ok += 1;
      } catch (e) {
        await conn.rollback().catch(() => {});
        erros.push({ id, error: e.message });
      }
    }
    for (const d of deptosAfetados) distribuidor.atribuir(d);
    res.json({ ok, total: ids.length, erros });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/conversas/forcar-finalizar — { ids:[] }. Marca como resolvida (sem despedida).
router.post('/forcar-finalizar', exigirPapel('ADMIN'), async (req, res, next) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) return res.status(400).json({ error: 'Informe ao menos uma conversa (ids).' });
  if (ids.length > 200) return res.status(400).json({ error: 'No máximo 200 conversas por vez.' });

  let conn;
  try {
    conn = await db.getConnection();
    const autorId = await getOrCreateAtendente(conn, req.user);
    let ok = 0; const erros = [];
    for (const id of ids) {
      try {
        const sel = await conn.execute(`SELECT DEPARTAMENTO_ID, PROTOCOLO, FILA_STATUS FROM MC_ZAP_CONVERSA WHERE ID = :id`, { id });
        if (!sel.rows.length) { erros.push({ id, error: 'não encontrada' }); continue; }
        if (sel.rows[0].FILA_STATUS === 'resolvida') { erros.push({ id, error: 'já resolvida' }); continue; }
        await conn.execute(
          `UPDATE MC_ZAP_CONVERSA SET STATUS = 'resolvida', FILA_STATUS = 'resolvida', RESOLVIDA_EM = SYSTIMESTAMP WHERE ID = :id`, { id });
        await conn.execute(
          `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
           VALUES (:atd, :m, 'encerramento', 'conversa', :id, :det)`,
          { atd: autorId, m: req.user && req.user.matricula, id, det: JSON.stringify({ forcada: true, protocolo: sel.rows[0].PROTOCOLO }) });
        await conn.commit();
        publish({ tipo: 'conversa', conversaId: id, departamentoId: sel.rows[0].DEPARTAMENTO_ID || null });
        ok += 1;
      } catch (e) {
        await conn.rollback().catch(() => {});
        erros.push({ id, error: e.message });
      }
    }
    res.json({ ok, total: ids.length, erros });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
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

  let conn;
  try {
    conn = await db.getConnection();
    if (!(await conversaNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    // Valida o atendente-alvo (existe e está ativo) — espelha o /transferir.
    if (alvoId !== perfil.atendenteId) {
      const alvo = await conn.execute(
        `SELECT 1 FROM MC_ZAP_ATENDENTE WHERE ID = :a AND ATIVO = 'S'`, { a: alvoId });
      if (!alvo.rows.length) return res.status(400).json({ error: 'Atendente inválido ou inativo.' });
    }
    const upd = await conn.execute(
      `UPDATE MC_ZAP_CONVERSA
          SET ATENDENTE_ID = :a, FILA_STATUS = 'em_atendimento', ATRIBUIDA_EM = SYSTIMESTAMP
        WHERE ID = :id AND FILA_STATUS = 'aguardando'`,
      { a: alvoId, id }
    );
    if (!upd.rowsAffected) {
      return res.status(409).json({ error: 'Conversa já foi atribuída (ou não está aguardando).' });
    }
    const cv = await conn.execute(
      `SELECT DEPARTAMENTO_ID FROM MC_ZAP_CONVERSA WHERE ID = :id`, { id }
    );
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:atd, :m, 'atribuicao', 'conversa', :id, :det)`,
      { atd: alvoId, m: req.user && req.user.matricula, id, det: JSON.stringify({ por: perfil.atendenteId }) }
    );
    await conn.commit();
    publish({
      tipo: 'atribuicao', conversaId: id, atendenteId: alvoId,
      departamentoId: cv.rows[0] ? cv.rows[0].DEPARTAMENTO_ID : null,
    });
    res.json({ ok: true, atendenteId: alvoId });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
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

  let conn;
  try {
    conn = await db.getConnection();
    if (!(await conversaNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    const sel = await conn.execute(
      `SELECT CONTATO_ID, DEPARTAMENTO_ID, ATENDENTE_ID, PROTOCOLO
         FROM MC_ZAP_CONVERSA WHERE ID = :id`, { id }
    );
    if (!sel.rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    const atual = sel.rows[0];

    // ATENDENTE só transfere para departamento que ele atende (gestor pode qualquer).
    if (paraDepto && !['ADMIN', 'SUPERVISOR'].includes((req.perfil || {}).papel)
        && !((req.perfil || {}).deptoIds || []).includes(paraDepto)) {
      return res.status(403).json({ error: 'Você só pode transferir para um departamento que atende.' });
    }

    let destinoTxt;
    if (paraDepto) {
      const dep = await conn.execute(
        `SELECT NOME FROM MC_ZAP_DEPARTAMENTO WHERE ID = :d AND ATIVO = 'S'`, { d: paraDepto }
      );
      if (!dep.rows.length) return res.status(400).json({ error: 'Departamento inválido/inativo' });
      destinoTxt = `departamento ${dep.rows[0].NOME}`;

      // Conversa do inbox geral ganhando depto pela 1ª vez → gera protocolo.
      const protocolo = atual.PROTOCOLO || await gerarProtocolo(conn);
      await conn.execute(
        `UPDATE MC_ZAP_CONVERSA
            SET DEPARTAMENTO_ID = :d, ATENDENTE_ID = NULL,
                FILA_STATUS = 'aguardando', FILA_ENTROU_EM = SYSTIMESTAMP,
                PROTOCOLO = :prot
          WHERE ID = :id`,
        { d: paraDepto, prot: protocolo, id }
      );
    } else {
      const atd = await conn.execute(
        `SELECT NOME FROM MC_ZAP_ATENDENTE WHERE ID = :a AND ATIVO = 'S'`, { a: paraAtendente }
      );
      if (!atd.rows.length) return res.status(400).json({ error: 'Atendente inválido/inativo' });
      destinoTxt = `atendente ${atd.rows[0].NOME || paraAtendente}`;
      await conn.execute(
        `UPDATE MC_ZAP_CONVERSA
            SET ATENDENTE_ID = :a, FILA_STATUS = 'em_atendimento', ATRIBUIDA_EM = SYSTIMESTAMP
          WHERE ID = :id`,
        { a: paraAtendente, id }
      );
    }

    // Nota interna automática (contexto pro próximo atendente).
    const autorId = await getOrCreateAtendente(conn, req.user);
    await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM (CONVERSA_ID, CONTATO_ID, ATENDENTE_ID, DIRECAO, TIPO, CONTEUDO, TS)
       VALUES (:cv, :ct, :atd, 'nota', 'text', :txt, SYSTIMESTAMP)`,
      {
        cv: id, ct: atual.CONTATO_ID, atd: autorId,
        txt: `Transferida para ${destinoTxt} por ${(req.user && req.user.nome) || 'sistema'}.`,
      }
    );
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:atd, :m, 'transferencia', 'conversa', :id, :det)`,
      {
        atd: autorId, m: req.user && req.user.matricula, id,
        det: JSON.stringify({ deDepto: atual.DEPARTAMENTO_ID, deAtendente: atual.ATENDENTE_ID, paraDepto, paraAtendente }),
      }
    );
    await conn.commit();

    // Notifica os DOIS lados (origem e destino) e aciona o distribuidor.
    publish({ tipo: 'transferencia', conversaId: id, departamentoId: atual.DEPARTAMENTO_ID || null });
    if (paraDepto && paraDepto !== atual.DEPARTAMENTO_ID) {
      publish({ tipo: 'transferencia', conversaId: id, departamentoId: paraDepto });
    }
    if (paraAtendente) {
      publish({ tipo: 'transferencia', conversaId: id, atendenteId: paraAtendente, departamentoId: atual.DEPARTAMENTO_ID || null });
    }
    if (paraDepto) distribuidor.atribuir(paraDepto);

    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

// POST /api/conversas/:id/encerrar — finaliza o atendimento { despedida? }.
// Seta STATUS e FILA_STATUS como 'resolvida' (próximo contato = conversa nova).
router.post('/:id/encerrar', naoAuditor, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const despedida = String((req.body && req.body.despedida) || '').trim();

  let conn;
  try {
    conn = await db.getConnection();
    if (!(await conversaNoEscopo(conn, id, req.perfil))) {
      return res.status(404).json({ error: 'Conversa não encontrada' });
    }
    const sel = await conn.execute(
      `SELECT c.CONTATO_ID, c.NUMERO_ID, c.DEPARTAMENTO_ID, c.JANELA_EXPIRA_EM, c.PROTOCOLO,
              ct.TELEFONE, n.PHONE_NUMBER_ID
         FROM MC_ZAP_CONVERSA c
         JOIN MC_ZAP_CONTATO ct ON ct.ID = c.CONTATO_ID
         LEFT JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
        WHERE c.ID = :id`,
      { id }
    );
    if (!sel.rows.length) return res.status(404).json({ error: 'Conversa não encontrada' });
    const cv = sel.rows[0];

    // Despedida (opcional, só com janela aberta) — falha não impede o encerramento.
    const atendenteId = await getOrCreateAtendente(conn, req.user);
    const expira = cv.JANELA_EXPIRA_EM ? new Date(cv.JANELA_EXPIRA_EM).getTime() : 0;
    if (despedida && expira > Date.now()) {
      try {
        const resp = await sendText(cv.TELEFONE, despedida, cv.PHONE_NUMBER_ID || undefined);
        const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
        await conn.execute(
          `INSERT INTO MC_ZAP_MENSAGEM
             (CONVERSA_ID, CONTATO_ID, NUMERO_ID, ATENDENTE_ID, WAMID, DIRECAO, TIPO, CONTEUDO, STATUS, TS)
           VALUES (:cv, :ct, :num, :atd, :wamid, 'out', 'text', :txt, 'sent', SYSTIMESTAMP)`,
          { cv: id, ct: cv.CONTATO_ID, num: cv.NUMERO_ID, atd: atendenteId, wamid: wamid || null, txt: despedida }
        );
      } catch (e) {
        console.error('[conversas] despedida falhou (encerrando mesmo assim):', e.message);
      }
    }

    await conn.execute(
      `UPDATE MC_ZAP_CONVERSA
          SET STATUS = 'resolvida', FILA_STATUS = 'resolvida', RESOLVIDA_EM = SYSTIMESTAMP
        WHERE ID = :id`,
      { id }
    );
    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ATENDENTE_ID, MATRICULA, ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES (:atd, :m, 'encerramento', 'conversa', :id, :det)`,
      { atd: atendenteId, m: req.user && req.user.matricula, id, det: JSON.stringify({ protocolo: cv.PROTOCOLO }) }
    );
    await conn.commit();

    publish({ tipo: 'conversa', conversaId: id, departamentoId: cv.DEPARTAMENTO_ID || null });
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
});

module.exports = router;
