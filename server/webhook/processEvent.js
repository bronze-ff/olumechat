// webhook/processEvent.js — Worker in-process: parseia o payload do webhook,
// resolve o número de origem (multi-número), baixa mídia recebida e persiste
// mensagens/status, gerenciando a janela de 24h.
// Dedup garantido pelo índice único MC_ZAP_MENSAGEM.WAMID. (PRD §5.3, RF-44/45/46)
const db = require('../db/pool');
const { oracledb } = db;
const { downloadMedia } = require('../graph/media');
const { classificar, registrarOpt, normalizar } = require('./optOut');
const { publish } = require('../realtime/hub');
const { codificar } = require('../utils/texto');
const { lerConfig } = require('../utils/configCache');
const { acharContato, variantes, normalizar: normTel } = require('../utils/telefone');
const { acharClientePorTelefone } = require('../utils/clienteLookup');
const { foraDeHorario } = require('../utils/horario');
const { descreverMensagem } = require('../utils/descreverMensagem');
const { gerarProtocolo } = require('../fila/protocolo');
const distribuidor = require('../fila/distribuidor');

const ORA_UNIQUE_VIOLATION = 1; // ORA-00001
const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'];

function epochToDate(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000) : new Date();
}

/** Garante o registro do número e devolve { id, departamentoPadraoId, fluxoAtivoId, modo }. */
async function getOrCreateNumero(conn, phoneNumberId, displayPhone) {
  if (!phoneNumberId) return { id: null, departamentoPadraoId: null, fluxoAtivoId: null, modo: 'padrao' };
  const sel = await conn.execute(
    `SELECT n.ID, n.DEPARTAMENTO_PADRAO_ID, n.MODO, f.ID AS FLUXO_ID
       FROM MC_ZAP_NUMERO n
       LEFT JOIN MC_ZAP_FLUXO f ON f.NUMERO_ID = n.ID AND f.ATIVO = 'S'
      WHERE n.PHONE_NUMBER_ID = :p`,
    { p: phoneNumberId }
  );
  if (sel.rows.length) {
    return {
      id: sel.rows[0].ID,
      departamentoPadraoId: sel.rows[0].DEPARTAMENTO_PADRAO_ID || null,
      fluxoAtivoId: sel.rows[0].FLUXO_ID || null,
      modo: sel.rows[0].MODO || 'padrao',
    };
  }

  const ins = await conn.execute(
    `INSERT INTO MC_ZAP_NUMERO (PHONE_NUMBER_ID, DISPLAY_PHONE)
     VALUES (:p, :d) RETURNING ID INTO :id`,
    {
      p: phoneNumberId,
      d: displayPhone || null,
      id: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
    }
  );
  return { id: ins.outBinds.id[0], departamentoPadraoId: null, fluxoAtivoId: null, modo: 'padrao' };
}

/** Garante o contato (casa variantes do 9º dígito) e devolve o ID.
    Se o contato já existia (ex.: criado por uma cobrança ativa, sem nome),
    completa o NOME_PERFIL quando o webhook trouxer o nome do WhatsApp. */
async function getOrCreateContato(conn, { telefone, waId, nome }) {
  const achado = await acharContato(conn, telefone);
  if (achado) {
    if (nome && !achado.NOME_PERFIL) {
      await conn.execute(
        `UPDATE MC_ZAP_CONTATO SET NOME_PERFIL = :n, WA_ID = COALESCE(WA_ID, :w) WHERE ID = :id`,
        { n: codificar(nome), w: waId || null, id: achado.ID }
      );
    }
    return achado.ID;
  }

  // Auto-identificação na chegada: casa o telefone com o WinThor (PCCLIENT) e já
  // nasce o contato com CODCLI + CNPJ + nome interno (razão social), em vez de
  // só o "nome do WhatsApp". Best-effort: nunca derruba a ingestão da mensagem.
  let cli = null;
  try { cli = await acharClientePorTelefone(conn, telefone); } catch { cli = null; }

  const ins = await conn.execute(
    `INSERT INTO MC_ZAP_CONTATO (TELEFONE, WA_ID, NOME_PERFIL, CODCLI, CGCENT, NOME_INTERNO)
     VALUES (:tel, :waId, :nome, :cod, :cgc, :ni) RETURNING ID INTO :id`,
    {
      tel: telefone,
      waId: waId || null,
      nome: codificar(nome) || null, // nomes de perfil com emoji (charset 1252)
      cod: cli ? cli.codcli : null,
      cgc: cli ? cli.cgcent : null,
      ni: cli ? codificar(cli.nome) : null,
      id: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
    }
  );
  return ins.outBinds.id[0];
}

/** Cliente trocou de número no WhatsApp (system/user_changed_number): migra o contato
    do número ANTIGO para o NOVO, preservando histórico e atendimento. Recebe os números
    já extraídos (o ANTIGO vem do texto system.body — ver a chamada). Usa o normalizador
    de TELEFONE (normTel) p/ não corromper o TELEFONE. Best-effort: erro só loga.
    Devolve os IDs das conversas afetadas (p/ notificar via SSE pós-commit). */
async function migrarNumeroContato(conn, { telefoneAntigo, telefoneNovo }) {
  try {
    const novo = normTel(telefoneNovo);
    const ant = normTel(telefoneAntigo);
    if (!novo || !ant || novo === ant) return []; // precisa de dois números distintos
    const antigo = await acharContato(conn, ant);
    if (!antigo) return []; // nada a migrar

    const conflito = await acharContato(conn, novo);
    if (conflito && conflito.ID === antigo.ID) return []; // já migrado
    if (conflito && conflito.ID !== antigo.ID) {
      // Número novo já é de outro contato → não sobrescreve; deixa p/ merge manual.
      await conn.execute(
        `INSERT INTO MC_ZAP_AUDITORIA (ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
         VALUES ('migracao_numero_conflito', 'contato', :id, :det)`,
        { id: antigo.ID, det: JSON.stringify({ antigo: ant, novo, contatoNovoId: conflito.ID }) }
      );
      return [];
    }

    try {
      await conn.execute(
        `UPDATE MC_ZAP_CONTATO SET TELEFONE = :novo, WA_ID = :wa WHERE ID = :id`,
        { novo, wa: novo, id: antigo.ID }
      );
    } catch (e) {
      if (e.errorNum === ORA_UNIQUE_VIOLATION) { // corrida: número novo passou a existir
        await conn.execute(
          `INSERT INTO MC_ZAP_AUDITORIA (ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
           VALUES ('migracao_numero_conflito', 'contato', :id, :det)`,
          { id: antigo.ID, det: JSON.stringify({ antigo: ant, novo, erro: 'ORA-00001' }) }
        );
        return [];
      }
      throw e;
    }

    await conn.execute(
      `INSERT INTO MC_ZAP_AUDITORIA (ACAO, ENTIDADE, ENTIDADE_ID, DETALHE)
       VALUES ('migracao_numero', 'contato', :id, :det)`,
      { id: antigo.ID, det: JSON.stringify({ antigo: ant, novo }) }
    );

    // Nota nas conversas ativas, pra ficar visível no chat (charset via codificar).
    const cvs = await conn.execute(
      `SELECT ID FROM MC_ZAP_CONVERSA WHERE CONTATO_ID = :cid AND STATUS <> 'resolvida'`,
      { cid: antigo.ID }
    );
    const txt = codificar(`📱 Cliente trocou de número: ${ant} → ${novo}`);
    const ids = [];
    for (const cv of cvs.rows) {
      await conn.execute(
        `INSERT INTO MC_ZAP_MENSAGEM (CONVERSA_ID, CONTATO_ID, DIRECAO, TIPO, CONTEUDO, TS)
         VALUES (:cv, :ct, 'nota', 'text', :txt, SYSTIMESTAMP)`,
        { cv: cv.ID, ct: antigo.ID, txt }
      );
      ids.push(cv.ID);
    }
    return ids;
  } catch (e) {
    console.error('[webhook] migrarNumeroContato falhou:', e.message);
    return [];
  }
}

/**
 * Abre/renova a conversa do contato, ajustando a janela 24h.
 * IMPORTANTE: a RENOVAÇÃO nunca toca FILA_STATUS/DEPARTAMENTO (ciclo de vida do
 * atendimento é ortogonal à janela). Conversa NOVA entra na fila do
 * departamento padrão do número (se houver) com protocolo gerado.
 * @returns {Promise<{id, criada, departamentoId, protocolo}>}
 */
async function openOrRenewConversa(conn, contatoId, numero, ts) {
  const expira = new Date(ts.getTime() + 24 * 60 * 60 * 1000);

  // Uma conversa por CONTATO + NÚMERO: o mesmo cliente falando no 1061 e no 1090
  // são dois atendimentos separados (canais diferentes). Sem o filtro de número,
  // a mensagem de um número grudava na conversa aberta do outro.
  const sel = await conn.execute(
    `SELECT ID, DEPARTAMENTO_ID, FILA_STATUS, PROTOCOLO, AVISO_FORA_HORARIO FROM MC_ZAP_CONVERSA
      WHERE CONTATO_ID = :cid AND STATUS <> 'resolvida'
        AND NVL(NUMERO_ID, -1) = NVL(:num, -1)
      ORDER BY CRIADO_EM DESC FETCH FIRST 1 ROWS ONLY`,
    { cid: contatoId, num: { type: oracledb.NUMBER, val: numero.id != null ? numero.id : null } }
  );

  if (sel.rows.length) {
    const id = sel.rows[0].ID;
    await conn.execute(
      `UPDATE MC_ZAP_CONVERSA
          SET JANELA_EXPIRA_EM = :exp, ULTIMA_MSG_EM = :ts, STATUS = 'aberta',
              NUMERO_ID = COALESCE(NUMERO_ID, :num)
        WHERE ID = :id`,
      { exp: expira, ts, num: numero.id, id }
    );
    return {
      id, criada: false, departamentoId: sel.rows[0].DEPARTAMENTO_ID || null,
      protocolo: sel.rows[0].PROTOCOLO || null, filaStatus: sel.rows[0].FILA_STATUS || null,
      avisoForaHorario: sel.rows[0].AVISO_FORA_HORARIO || 'N',
    };
  }

  // Conversa nova: número em MODO='ia' → bot de IA; senão, número com FLUXO
  // ativo → autoatendimento (bot determinístico); senão, com depto padrão →
  // fila (aguardando); senão → inbox geral.
  let fluxoId, departamentoId, filaStatus;
  if (numero.modo === 'ia') {
    fluxoId = null; departamentoId = null; filaStatus = 'ia';
  } else {
    fluxoId = numero.fluxoAtivoId || null;
    departamentoId = fluxoId ? null : (numero.departamentoPadraoId || null);
    filaStatus = fluxoId ? 'bot' : (departamentoId ? 'aguardando' : 'em_atendimento');
  }
  const protocolo = (fluxoId || departamentoId || numero.modo === 'ia') ? await gerarProtocolo(conn) : null;

  const ins = await conn.execute(
    `INSERT INTO MC_ZAP_CONVERSA
       (CONTATO_ID, NUMERO_ID, STATUS, JANELA_EXPIRA_EM, ULTIMA_MSG_EM,
        DEPARTAMENTO_ID, FILA_STATUS, PROTOCOLO, BOT_FLUXO_ID,
        FILA_ENTROU_EM, BOT_ULTIMA_INTERACAO)
     VALUES (:cid, :num, 'aberta', :exp, :ts,
        :dep, :fst, :prot, :flx,
        ${departamentoId ? 'SYSTIMESTAMP' : 'NULL'},
        ${fluxoId ? 'SYSTIMESTAMP' : 'NULL'})
     RETURNING ID INTO :id`,
    {
      cid: contatoId, num: numero.id, exp: expira, ts,
      dep: departamentoId, fst: filaStatus, prot: protocolo, flx: fluxoId,
      id: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
    }
  );
  return { id: ins.outBinds.id[0], criada: true, departamentoId, protocolo, filaStatus, avisoForaHorario: 'N' };
}

/** Baixa a mídia para o disco e devolve os metadados (ou null se falhar). */
async function safeDownload(mediaObj) {
  try {
    return await downloadMedia(mediaObj);
  } catch (err) {
    console.error('[webhook] Falha ao baixar/gravar mídia:', err.message);
    return null; // não perde a mensagem por causa da mídia
  }
}

/** Insere mensagem recebida (mídia embutida); ignora duplicados (dedup por WAMID). */
async function insertInbound(conn, m) {
  const media = m.media || {};
  try {
    await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM
         (CONVERSA_ID, CONTATO_ID, NUMERO_ID, WAMID, DIRECAO, TIPO, CONTEUDO, TS,
          MEDIA_ID, MIME_TYPE, NOME_ARQUIVO, MIDIA_CAMINHO, MIDIA_TAMANHO, MIDIA_SHA256)
       VALUES (:cv, :ct, :num, :wamid, 'in', :tipo, :cont, :ts,
          :mediaId, :mime, :nome, :cam, :tam, :sha)`,
      {
        cv: m.conversaId, ct: m.contatoId, num: m.numeroId,
        wamid: m.wamid, tipo: m.tipo, cont: codificar(m.conteudo), ts: m.ts,
        mediaId: media.mediaId || null, mime: media.mime || null,
        nome: media.filename || null, cam: media.caminho || null,
        tam: media.size || null, sha: media.sha256 || null,
      }
    );
    return true;
  } catch (err) {
    if (err.errorNum === ORA_UNIQUE_VIOLATION) return false; // duplicado — ok
    throw err;
  }
}

// Status da Meta → status do item de campanha.
const STATUS_CAMPANHA = { delivered: 'entregue', read: 'lido', failed: 'falha' };

/** Atualiza o status de uma mensagem enviada (sent/delivered/read/failed).
    Também propaga para o item de campanha (Fase 6), se o WAMID for de um disparo. */
async function updateStatus(conn, { wamid, status, erroCodigo }) {
  // NÃO sobrescreve o TS. O TS é o horário de ENVIO da mensagem e é o que ordena o
  // thread. O recibo de entrega/leitura pode chegar horas depois (cliente offline),
  // e regravar o TS com a hora do recibo bagunçava a ordem — a nossa mensagem
  // "descia" para depois das respostas, parecendo que o cliente falou primeiro.
  // Aqui só muda o STATUS (sent/delivered/read/failed) e o código de erro.
  await conn.execute(
    `UPDATE MC_ZAP_MENSAGEM
        SET STATUS = :st, ERRO_CODIGO = COALESCE(:err, ERRO_CODIGO)
      WHERE WAMID = :wamid`,
    { st: status, err: erroCodigo || null, wamid }
  );
  const stCamp = STATUS_CAMPANHA[status];
  if (stCamp) {
    await conn.execute(
      `UPDATE MC_ZAP_CAMPANHA_ITEM
          SET STATUS = :st, ERRO_CODIGO = COALESCE(:err, ERRO_CODIGO)
        WHERE WAMID = :wamid`,
      { st: stCamp, err: erroCodigo || null, wamid }
    );
  }
}

/**
 * Confirmação do encerramento por comando do cliente: envia a mensagem
 * configurada (se houver) e persiste a saída. Isolado — falha não afeta nada.
 */
async function confirmarEncerramento(evt) {
  if (!evt.confirmacao) return;
  const { render } = require('../bot/engine');
  const { sendText } = require('../graph/sendText');
  const texto = render(evt.confirmacao, { protocolo: evt.protocolo || '' }, {});
  let conn;
  try {
    let wamid = null;
    try {
      const resp = await sendText(evt.telefone, texto, evt.phoneNumberId || undefined);
      wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
    } catch (e) {
      console.error('[webhook] confirmação de encerramento não enviada:', e.message);
    }
    conn = await db.getConnection();
    await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM
         (CONVERSA_ID, CONTATO_ID, NUMERO_ID, WAMID, DIRECAO, TIPO, CONTEUDO, STATUS, TS)
       VALUES (:cv, :ct, :num, :wamid, 'out', 'text', :txt, 'sent', SYSTIMESTAMP)`,
      { cv: evt.conversaId, ct: evt.contatoId, num: evt.numeroId, wamid, txt: codificar(texto) }
    );
    await conn.commit();
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('[webhook] persistência da confirmação falhou:', err.message);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/**
 * Envia o aviso de FORA DE HORÁRIO (texto livre, dentro da janela de 24h que a
 * própria mensagem do cliente abriu) e persiste a saída. Isolado — falha não
 * afeta a ingestão. A flag AVISO_FORA_HORARIO já foi marcada na transação.
 */
async function enviarAvisoForaHorario(evt) {
  const { sendText } = require('../graph/sendText');
  let conn;
  try {
    let wamid = null;
    try {
      const resp = await sendText(evt.telefone, evt.texto, evt.phoneNumberId || undefined);
      wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
    } catch (e) {
      console.error('[webhook] aviso de fora de horário não enviado:', e.message);
      return;
    }
    conn = await db.getConnection();
    await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM
         (CONVERSA_ID, CONTATO_ID, NUMERO_ID, WAMID, DIRECAO, TIPO, CONTEUDO, STATUS, TS)
       VALUES (:cv, :ct, :num, :wamid, 'out', 'text', :txt, 'sent', SYSTIMESTAMP)`,
      { cv: evt.conversaId, ct: evt.contatoId, num: evt.numeroId, wamid, txt: codificar(evt.texto) }
    );
    await conn.commit();
    publish({ tipo: 'mensagem', direcao: 'out', conversaId: evt.conversaId, contatoId: evt.contatoId });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('[webhook] persistência do aviso fora de horário falhou:', err.message);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/**
 * Rastreabilidade da campanha: quando o cliente RESPONDE (conversa nova), procura
 * um disparo recente (Modelo B não cria conversa nem grava a mensagem enviada) e
 * deixa uma NOTA interna com o contexto — assim o atendente sabe que é resposta
 * de campanha e o que foi mandado. Tolerante: nunca derruba a ingestão.
 * A NOTA recebe TS = data do disparo, então aparece ANTES da resposta no chat.
 */
async function anotarRespostaCampanha(conn, { conversaId, contatoId, telefone }) {
  try {
    const vs = variantes(telefone);
    const binds = {};
    const marks = vs.map((v, i) => { binds['t' + i] = v; return ':t' + i; });
    const r = await conn.execute(
      `SELECT ci.VARIAVEIS, ci.ENVIADO_EM, c.NOME AS CAMP_NOME, c.TEMPLATE_NOME
         FROM MC_ZAP_CAMPANHA_ITEM ci
         JOIN MC_ZAP_CAMPANHA c ON c.ID = ci.CAMPANHA_ID
        WHERE ci.STATUS IN ('enviado','entregue','lido')
          AND ci.ENVIADO_EM >= SYSDATE - 30
          AND ci.TELEFONE IN (${marks.join(',')})
        ORDER BY ci.ENVIADO_EM DESC, ci.ID DESC FETCH FIRST 1 ROWS ONLY`,
      binds
    );
    if (!r.rows.length) return;
    const row = r.rows[0];
    let vars = [];
    try {
      const raw = row.VARIAVEIS == null ? null
        : (typeof row.VARIAVEIS === 'string' ? row.VARIAVEIS : await row.VARIAVEIS.getData());
      vars = raw ? JSON.parse(raw) : [];
    } catch { vars = []; }
    const quando = row.ENVIADO_EM ? new Date(row.ENVIADO_EM).toLocaleString('pt-BR') : '';
    const dados = vars.length ? ` Dados enviados: ${vars.join(' · ')}.` : '';
    const texto = `📣 Resposta a uma campanha. Disparo "${row.CAMP_NOME || ''}"`
      + (row.TEMPLATE_NOME ? ` (template ${row.TEMPLATE_NOME})` : '')
      + (quando ? ` enviado em ${quando}.` : '.') + dados;
    await conn.execute(
      `INSERT INTO MC_ZAP_MENSAGEM (CONVERSA_ID, CONTATO_ID, DIRECAO, TIPO, CONTEUDO, TS)
       VALUES (:cv, :ct, 'nota', 'text', :txt, :ts)`,
      { cv: conversaId, ct: contatoId, txt: codificar(texto), ts: row.ENVIADO_EM || new Date() }
    );
  } catch (err) {
    if (err.errorNum === 942) return; // tabelas de campanha podem não existir
    console.error('[webhook] nota de resposta de campanha falhou:', err.message);
  }
}

/** Processa um payload bruto do webhook (objeto já parseado). Idempotente. */
async function processPayload(payload) {
  const entries = payload.entry || [];
  const eventos = []; // publicados no hub (SSE) só após o commit
  let conn;
  try {
    conn = await db.getConnection();

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const meta = value.metadata || {};
        const numero = await getOrCreateNumero(conn, meta.phone_number_id, meta.display_phone_number);
        const numeroId = numero.id;
        const contacts = value.contacts || [];

        // --- Mensagens recebidas ---
        for (const msg of value.messages || []) {
          const ts = epochToDate(msg.timestamp);
          // Cliente trocou de número (system/user_changed_number): o número ANTIGO só
          // vem no texto livre `system.body` ("...changed from X to Y") — tanto `from`
          // quanto `system.wa_id` costumam trazer o NOVO. Extraímos do body (com fallback
          // p/ from/wa_id), migramos o contato e seguimos (sem gravar a mensagem system).
          if (msg.type === 'system' && msg.system &&
              (msg.system.type === 'user_changed_number' || msg.system.type === 'customer_changed_number')) {
            const corpo = String(msg.system.body || '').replace(/[‎‏]/g, '');
            const mm = corpo.match(/from\s+\+?(\d+)\s+to\s+\+?(\d+)/i);
            const ids = await migrarNumeroContato(conn, {
              telefoneAntigo: (mm && mm[1]) || msg.from,
              telefoneNovo: (mm && mm[2]) || msg.system.wa_id,
            });
            for (const id of ids) eventos.push({ tipo: 'conversa', conversaId: id });
            continue;
          }
          // Reação (emoji) só é registrada se já houver conversa ABERTA — não cria
          // atendimento nem entra na fila (evita "ticket" por um emoji). Sem conversa
          // aberta → ignora. (Com aberta, o fluxo abaixo só RENOVA e registra a reação.)
          if (msg.type === 'reaction') {
            const ct = await acharContato(conn, msg.from);
            let temAberta = false;
            if (ct) {
              const r = await conn.execute(
                `SELECT 1 FROM MC_ZAP_CONVERSA
                  WHERE CONTATO_ID = :cid AND STATUS <> 'resolvida' AND NVL(NUMERO_ID, -1) = NVL(:num, -1) AND ROWNUM = 1`,
                { cid: ct.ID, num: numeroId }
              );
              temAberta = r.rows.length > 0;
            }
            if (!temAberta) continue;
          }
          const contact = contacts.find((c) => c.wa_id) || contacts[0] || {};
          const contatoId = await getOrCreateContato(conn, {
            telefone: msg.from,
            waId: contact.wa_id,
            nome: contact.profile && contact.profile.name,
          });
          const conversa = await openOrRenewConversa(conn, contatoId, numero, ts);
          const conversaId = conversa.id;

          // Mídia: baixa para o disco; metadados embutidos na mensagem.
          let media = null;
          let conteudo;
          if (MEDIA_TYPES.includes(msg.type) && msg[msg.type] && msg[msg.type].id) {
            media = await safeDownload(msg[msg.type]);
            conteudo = msg[msg.type].caption || null;
          } else if (msg.type === 'text' && msg.text) {
            conteudo = msg.text.body;
          } else {
            // Todo o resto (system, reaction, button, interactive, order, contacts,
            // location, ...) → texto amigável centralizado, nunca JSON cru.
            conteudo = descreverMensagem(msg.type, msg[msg.type]);
          }

          const novoInbound = await insertInbound(conn, {
            conversaId, contatoId, numeroId, media,
            wamid: msg.id, tipo: msg.type, conteudo, ts,
          });
          // Reentrega do MESMO webhook pela Meta (WAMID duplicado) → insertInbound
          // devolve false. NÃO reprocessa: senão a IA/bot responde de novo, há
          // dupla notificação SSE e opt-out/encerramento/rastro de campanha repetidos.
          if (!novoInbound) continue;
          // Conversa nova = possível resposta a um disparo de campanha → deixa o rastro.
          if (conversa.criada) {
            await anotarRespostaCampanha(conn, { conversaId, contatoId, telefone: msg.from });
          }
          eventos.push({
            tipo: 'mensagem', direcao: 'in', conversaId, contatoId,
            departamentoId: conversa.departamentoId, numeroId,
          });

          // Opt-out/opt-in automático (LGPD): "PARAR" descadastra, "VOLTAR" reativa.
          // Roda ANTES do bot — opt-out encerra o autoatendimento na hora.
          let optAcao = null;
          // Conversa da IA = usuário interno autorizado: não aplicamos opt-out por
          // palavra solta (bloquearia a resposta e deixaria a conversa presa sem
          // encerrar). O encerramento por comando explícito (abaixo) continua valendo.
          if (msg.type === 'text' && msg.text && conversa.filaStatus !== 'ia') {
            optAcao = classificar(msg.text.body);
            if (optAcao) {
              await registrarOpt(conn, oracledb, {
                contatoId, telefone: msg.from, acao: optAcao, origem: 'whatsapp_inbound',
              });
              console.log(`[webhook] ${optAcao} registrado p/ contato ${contatoId} (${msg.from})`);
              if (optAcao === 'optout' && conversa.filaStatus === 'bot') {
                await conn.execute(
                  `UPDATE MC_ZAP_CONVERSA
                      SET STATUS = 'resolvida', FILA_STATUS = 'resolvida', RESOLVIDA_EM = SYSTIMESTAMP
                    WHERE ID = :id AND FILA_STATUS = 'bot'`,
                  { id: conversaId }
                );
              }
            }
          }

          // Comando de ENCERRAMENTO pelo cliente (config 'comando_encerrar' em
          // Ajustes): encerra o atendimento em qualquer estado (bot/fila/humano).
          let encerrouPorComando = false;
          if (!optAcao && msg.type === 'text' && msg.text) {
            const cfgZap = await lerConfig(conn);
            const comando = String(cfgZap.comando_encerrar || '').trim();
            if (comando && normalizar(msg.text.body) === normalizar(comando)) {
              await conn.execute(
                `UPDATE MC_ZAP_CONVERSA
                    SET STATUS = 'resolvida', FILA_STATUS = 'resolvida', RESOLVIDA_EM = SYSTIMESTAMP
                  WHERE ID = :id AND FILA_STATUS <> 'resolvida'`,
                { id: conversaId }
              );
              eventos.push({
                tipo: 'encerrar_cliente', conversaId, contatoId,
                telefone: msg.from, numeroId,
                phoneNumberId: meta.phone_number_id,
                protocolo: conversa.protocolo || null,
                confirmacao: String(cfgZap.msg_encerrar_cliente || '').trim(),
                departamentoId: conversa.departamentoId || null,
              });
              encerrouPorComando = true;
              console.log(`[webhook] atendimento ${conversaId} encerrado por comando do cliente`);
            }
          }

          // Gatilhos de fila/bot — só quando o cliente NÃO encerrou agora.
          if (!encerrouPorComando) {
            if (conversa.criada && conversa.departamentoId) {
              eventos.push({
                tipo: 'fila', conversaId, departamentoId: conversa.departamentoId,
                numeroId, protocolo: conversa.protocolo,
              });
            }
            if (conversa.criada && conversa.filaStatus === 'bot') {
              eventos.push({ tipo: 'bot_iniciar', conversaId }); // saudação pós-commit
            }
            // Conversa em autoatendimento: o bot responde (pós-commit, fora da tx).
            if (!optAcao && conversa.filaStatus === 'bot' && !conversa.criada
                && msg.type === 'text' && msg.text) {
              eventos.push({ tipo: 'bot_entrada', conversaId, texto: msg.text.body });
            }
            // Conversa em atendimento pelo bot de IA: runtime próprio. Diferente do
            // 'bot' (que na 1ª msg só saúda), a IA responde JÁ NA PRIMEIRA mensagem
            // (ela é a própria pergunta) — por isso NÃO exige !conversa.criada.
            if (!optAcao && conversa.filaStatus === 'ia'
                && msg.type === 'text' && msg.text) {
              eventos.push({ tipo: 'ia_entrada', conversaId, texto: msg.text.body });
            }
          }

          // Aviso de FORA DE HORÁRIO (config): só quando um atendimento NOVO entra
          // fora do horário. Conversa JÁ ABERTA dentro do expediente que continua
          // depois do fim (cliente já em atendimento) NÃO recebe o aviso. Bot e
          // bot de IA respondem 24/7, então ficam de fora. Também não em
          // opt-out/encerramento.
          if (conversa.criada && conversa.filaStatus !== 'bot' && conversa.filaStatus !== 'ia' && !optAcao && !encerrouPorComando) {
            const cfgFH = await lerConfig(conn); // cache de 60s
            if (foraDeHorario(cfgFH, ts) && String(cfgFH.fora_horario_msg || '').trim()) {
              await conn.execute(
                `UPDATE MC_ZAP_CONVERSA SET AVISO_FORA_HORARIO = 'S' WHERE ID = :id`, { id: conversaId });
              eventos.push({
                tipo: 'fora_horario', conversaId, contatoId, numeroId,
                telefone: msg.from, phoneNumberId: meta.phone_number_id,
                texto: String(cfgFH.fora_horario_msg).trim(),
              });
            }
          }
        }

        // --- Status de mensagens enviadas ---
        for (const st of value.statuses || []) {
          const erro = (st.errors && st.errors[0] && String(st.errors[0].code)) || null;
          await updateStatus(conn, {
            wamid: st.id, status: st.status, erroCodigo: erro,
          });
          eventos.push({ tipo: 'status', wamid: st.id, status: st.status });
        }
      }
    }

    await conn.commit();
    // Só notifica os clientes (SSE) depois de persistir com sucesso.
    // Eventos bot_* são internos: viram chamadas ao runtime (isolado, pós-commit).
    const runtime = require('../bot/runtime');
    for (const evt of eventos) {
      if (evt.tipo === 'bot_iniciar') { runtime.iniciarFluxo(evt.conversaId); continue; }
      if (evt.tipo === 'bot_entrada') { runtime.processarEntrada(evt.conversaId, evt.texto); continue; }
      if (evt.tipo === 'ia_entrada') { require('../ia/runtime').processarEntrada(evt.conversaId, evt.texto); continue; }
      if (evt.tipo === 'encerrar_cliente') {
        confirmarEncerramento(evt); // envia a confirmação fora da tx (isolado)
        publish({ tipo: 'conversa', conversaId: evt.conversaId, departamentoId: evt.departamentoId });
        continue;
      }
      if (evt.tipo === 'fora_horario') { enviarAvisoForaHorario(evt); continue; }
      publish(evt);
      // Conversa nova na fila → tenta distribuir (fora da transação do webhook).
      if (evt.tipo === 'fila') distribuidor.atribuir(evt.departamentoId);
    }
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    throw err;
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

module.exports = { processPayload };
