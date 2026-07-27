// webhook/processEvent.js — Worker in-process: parseia o payload do webhook,
// resolve o TENANT e o número de origem (multi-número), baixa mídia recebida
// e persiste mensagens/status, gerenciando a janela de 24h.
// Dedup garantido pelo índice único mensagem.wamid (por tenant). (PRD §5.3, RF-44/45/46)
//
// ── TENANT: como o webhook descobre de quem é a mensagem ───────────────────
// A Meta manda `phone_number_id` no payload — não manda tenant nenhum. O único
// jeito de saber de quem é a mensagem é olhar em `numero` QUEM registrou aquele
// phone_number_id (é a única unicidade GLOBAL do schema — ver migração 001).
// Esse UM lookup roda FORA de comTenant(), direto no pool (papel dono do banco,
// que ignora RLS) — é o único lugar do sistema que faz isso, e é proposital: sem
// ele não dá pra descobrir o tenant pra abrir o comTenant() certo. TODO o resto
// (contato, conversa, mensagem, auditoria) roda DENTRO de comTenant(tenantId).
// phone_number_id desconhecido (número não provisionado para nenhum tenant) =
// evento IGNORADO — nunca cria conversa órfã nem adivinha um tenant.
'use strict';

const db = require('../db/pool');
const { tipos } = db;
const { downloadMedia } = require('../graph/media');
const { classificar, registrarOpt, normalizar } = require('./optOut');
const { publish } = require('../realtime/hub');
const { lerConfig } = require('../utils/configCache');
const { acharContato, variantes, normalizar: normTel } = require('../utils/telefone');
const { acharClientePorTelefone } = require('../utils/clienteLookup');
const { foraDeHorario } = require('../utils/horario');
const { descreverMensagem } = require('../utils/descreverMensagem');
const { gerarProtocolo } = require('../fila/protocolo');
const distribuidor = require('../fila/distribuidor');

const PG_UNIQUE_VIOLATION = '23505';
const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'];

function epochToDate(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000) : new Date();
}

/**
 * Acha QUEM é o dono (tenant) do phone_number_id — o único lookup do módulo
 * que roda fora de comTenant() (ver cabeçalho do arquivo). Devolve
 * { id, tenantId, departamentoPadraoId, fluxoAtivoId, modo } ou null se o
 * número não estiver provisionado para nenhum tenant.
 */
async function resolverNumero(phoneNumberId) {
  if (!phoneNumberId) return null;
  const conn = await db.getConnection();
  try {
    const r = await conn.execute(
      `SELECT n.id, n.tenant_id, n.departamento_padrao_id, n.modo, f.id AS fluxo_id
         FROM numero n
         LEFT JOIN fluxo f ON f.tenant_id = n.tenant_id AND f.numero_id = n.id AND f.ativo = 'S'
        WHERE n.phone_number_id = :p`,
      { p: phoneNumberId }
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      id: row.ID,
      tenantId: row.TENANT_ID,
      departamentoPadraoId: row.DEPARTAMENTO_PADRAO_ID || null,
      fluxoAtivoId: row.FLUXO_ID || null,
      modo: row.MODO || 'padrao',
    };
  } finally {
    await conn.close().catch(() => {});
  }
}

/** Garante o contato (casa variantes do 9º dígito) e devolve o ID.
    Se o contato já existia (ex.: criado por uma cobrança ativa, sem nome),
    completa o NOME_PERFIL quando o webhook trouxer o nome do WhatsApp. */
async function getOrCreateContato(conn, { telefone, waId, nome }) {
  const achado = await acharContato(conn, telefone);
  if (achado) {
    if (nome && !achado.NOME_PERFIL) {
      await conn.execute(
        `UPDATE contato SET nome_perfil = :n, wa_id = COALESCE(wa_id, :w) WHERE id = :id`,
        { n: nome, w: waId || null, id: achado.ID }
      );
    }
    return achado.ID;
  }

  // Auto-identificação na chegada: casa o telefone com o sistema do tenant (seam
  // clienteLookup) e já nasce o contato com CODIGO_EXTERNO + DOCUMENTO + nome
  // interno, em vez de só o "nome do WhatsApp". Best-effort: nunca derruba a
  // ingestão da mensagem.
  let cli = null;
  try { cli = await acharClientePorTelefone(conn, telefone); } catch { cli = null; }

  const ins = await conn.execute(
    `INSERT INTO contato (telefone, wa_id, nome_perfil, codigo_externo, documento, nome_interno)
     VALUES (:tel, :waId, :nome, :cod, :doc, :ni) RETURNING id INTO :id`,
    {
      tel: telefone,
      waId: waId || null,
      nome: nome || null,
      cod: cli ? cli.codigo : null,
      doc: cli ? cli.documento : null,
      ni: cli ? cli.nome : null,
      id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
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
        `INSERT INTO auditoria (acao, entidade, entidade_id, detalhe)
         VALUES ('migracao_numero_conflito', 'contato', :id, :det)`,
        { id: antigo.ID, det: JSON.stringify({ antigo: ant, novo, contatoNovoId: conflito.ID }) }
      );
      return [];
    }

    try {
      await conn.execute(
        `UPDATE contato SET telefone = :novo, wa_id = :wa WHERE id = :id`,
        { novo, wa: novo, id: antigo.ID }
      );
    } catch (e) {
      if (e.code === PG_UNIQUE_VIOLATION) { // corrida: número novo passou a existir
        await conn.execute(
          `INSERT INTO auditoria (acao, entidade, entidade_id, detalhe)
           VALUES ('migracao_numero_conflito', 'contato', :id, :det)`,
          { id: antigo.ID, det: JSON.stringify({ antigo: ant, novo, erro: '23505' }) }
        );
        return [];
      }
      throw e;
    }

    await conn.execute(
      `INSERT INTO auditoria (acao, entidade, entidade_id, detalhe)
       VALUES ('migracao_numero', 'contato', :id, :det)`,
      { id: antigo.ID, det: JSON.stringify({ antigo: ant, novo }) }
    );

    // Nota nas conversas ativas, pra ficar visível no chat.
    const cvs = await conn.execute(
      `SELECT id FROM conversa WHERE contato_id = :cid AND status <> 'resolvida'`,
      { cid: antigo.ID }
    );
    const txt = `📱 Cliente trocou de número: ${ant} → ${novo}`;
    const ids = [];
    for (const cv of cvs.rows) {
      await conn.execute(
        `INSERT INTO mensagem (conversa_id, contato_id, direcao, tipo, conteudo, ts)
         VALUES (:cv, :ct, 'nota', 'text', :txt, now())`,
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
    `SELECT id, departamento_id, fila_status, protocolo, aviso_fora_horario FROM conversa
      WHERE contato_id = :cid AND status <> 'resolvida'
        AND COALESCE(numero_id, -1) = COALESCE(:num, -1)
      ORDER BY criado_em DESC FETCH FIRST 1 ROWS ONLY`,
    { cid: contatoId, num: { type: tipos.NUMBER, val: numero.id != null ? numero.id : null } }
  );

  if (sel.rows.length) {
    const id = sel.rows[0].ID;
    await conn.execute(
      `UPDATE conversa
          SET janela_expira_em = :exp, ultima_msg_em = :ts, status = 'aberta',
              numero_id = COALESCE(numero_id, :num)
        WHERE id = :id`,
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
    `INSERT INTO conversa
       (contato_id, numero_id, status, janela_expira_em, ultima_msg_em,
        departamento_id, fila_status, protocolo, bot_fluxo_id,
        fila_entrou_em, bot_ultima_interacao)
     VALUES (:cid, :num, 'aberta', :exp, :ts,
        :dep, :fst, :prot, :flx,
        ${departamentoId ? 'now()' : 'NULL'},
        ${fluxoId ? 'now()' : 'NULL'})
     RETURNING id INTO :id`,
    {
      cid: contatoId, num: numero.id, exp: expira, ts,
      dep: departamentoId, fst: filaStatus, prot: protocolo, flx: fluxoId,
      id: { type: tipos.NUMBER, dir: tipos.BIND_OUT },
    }
  );
  return { id: ins.outBinds.id[0], criada: true, departamentoId, protocolo, filaStatus, avisoForaHorario: 'N' };
}

/** Baixa a mídia para o disco e devolve os metadados (ou null se falhar). */
async function safeDownload(mediaObj, phoneNumberId, tenantId) {
  try {
    return await downloadMedia(mediaObj, phoneNumberId, tenantId);
  } catch (err) {
    console.error('[webhook] Falha ao baixar/gravar mídia:', err.message);
    return null; // não perde a mensagem por causa da mídia
  }
}

/** Insere mensagem recebida (mídia embutida); ignora duplicados (dedup por WAMID).
    ON CONFLICT DO NOTHING em vez de capturar 23505: um erro de verdade deixaria a
    transação em estado abortado no Postgres (25P02) até o ROLLBACK — as PRÓXIMAS
    mensagens do MESMO change (mesma transação tenant-scoped) parariam de gravar
    silenciosamente. Redelivery da Meta (webhook reenviado) precisa continuar
    idempotente sem envenenar o resto do lote. */
async function insertInbound(conn, m) {
  const media = m.media || {};
  const r = await conn.execute(
    `INSERT INTO mensagem
       (conversa_id, contato_id, numero_id, wamid, direcao, tipo, conteudo, ts,
        media_id, mime_type, nome_arquivo, midia_caminho, midia_tamanho, midia_sha256)
     VALUES (:cv, :ct, :num, :wamid, 'in', :tipo, :cont, :ts,
        :mediaId, :mime, :nome, :cam, :tam, :sha)
     ON CONFLICT (tenant_id, wamid) DO NOTHING`,
    {
      cv: m.conversaId, ct: m.contatoId, num: m.numeroId,
      wamid: m.wamid, tipo: m.tipo, cont: m.conteudo, ts: m.ts,
      mediaId: media.mediaId || null, mime: media.mime || null,
      nome: media.filename || null, cam: media.caminho || null,
      tam: media.size || null, sha: media.sha256 || null,
    }
  );
  return Boolean(r.rowsAffected);
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
    `UPDATE mensagem
        SET status = :st, erro_codigo = COALESCE(:err, erro_codigo)
      WHERE wamid = :wamid`,
    { st: status, err: erroCodigo || null, wamid }
  );
  const stCamp = STATUS_CAMPANHA[status];
  if (stCamp) {
    await conn.execute(
      `UPDATE campanha_item
          SET status = :st, erro_codigo = COALESCE(:err, erro_codigo)
        WHERE wamid = :wamid`,
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
  let wamid = null;
  try {
    const resp = await sendText(evt.telefone, texto, evt.phoneNumberId || undefined, evt.tenantId);
    wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
  } catch (e) {
    console.error('[webhook] confirmação de encerramento não enviada:', e.message);
  }
  try {
    await db.comTenant(evt.tenantId, async (conn) => {
      await conn.execute(
        `INSERT INTO mensagem
           (conversa_id, contato_id, numero_id, wamid, direcao, tipo, conteudo, status, ts)
         VALUES (:cv, :ct, :num, :wamid, 'out', 'text', :txt, 'sent', now())`,
        { cv: evt.conversaId, ct: evt.contatoId, num: evt.numeroId, wamid, txt: texto }
      );
    });
  } catch (err) {
    console.error('[webhook] persistência da confirmação falhou:', err.message);
  }
}

/**
 * Envia o aviso de FORA DE HORÁRIO (texto livre, dentro da janela de 24h que a
 * própria mensagem do cliente abriu) e persiste a saída. Isolado — falha não
 * afeta a ingestão. A flag AVISO_FORA_HORARIO já foi marcada na transação.
 */
async function enviarAvisoForaHorario(evt) {
  const { sendText } = require('../graph/sendText');
  let wamid = null;
  try {
    const resp = await sendText(evt.telefone, evt.texto, evt.phoneNumberId || undefined, evt.tenantId);
    wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
  } catch (e) {
    console.error('[webhook] aviso de fora de horário não enviado:', e.message);
    return;
  }
  try {
    await db.comTenant(evt.tenantId, async (conn) => {
      await conn.execute(
        `INSERT INTO mensagem
           (conversa_id, contato_id, numero_id, wamid, direcao, tipo, conteudo, status, ts)
         VALUES (:cv, :ct, :num, :wamid, 'out', 'text', :txt, 'sent', now())`,
        { cv: evt.conversaId, ct: evt.contatoId, num: evt.numeroId, wamid, txt: evt.texto }
      );
    });
    publish({ tipo: 'mensagem', direcao: 'out', conversaId: evt.conversaId, contatoId: evt.contatoId, tenantId: evt.tenantId });
  } catch (err) {
    console.error('[webhook] persistência do aviso fora de horário falhou:', err.message);
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
      `SELECT ci.variaveis, ci.enviado_em, c.nome AS camp_nome, c.template_nome
         FROM campanha_item ci
         JOIN campanha c ON c.tenant_id = ci.tenant_id AND c.id = ci.campanha_id
        WHERE ci.status IN ('enviado','entregue','lido')
          AND ci.enviado_em >= now() - interval '30 days'
          AND ci.telefone IN (${marks.join(',')})
        ORDER BY ci.enviado_em DESC, ci.id DESC FETCH FIRST 1 ROWS ONLY`,
      binds
    );
    if (!r.rows.length) return;
    const row = r.rows[0];
    let vars = [];
    try {
      const raw = row.VARIAVEIS == null ? null
        : (typeof row.VARIAVEIS === 'string' ? row.VARIAVEIS : JSON.stringify(row.VARIAVEIS));
      vars = raw ? JSON.parse(raw) : [];
    } catch { vars = []; }
    const quando = row.ENVIADO_EM ? new Date(row.ENVIADO_EM).toLocaleString('pt-BR') : '';
    const dados = vars.length ? ` Dados enviados: ${vars.join(' · ')}.` : '';
    const texto = `📣 Resposta a uma campanha. Disparo "${row.CAMP_NOME || ''}"`
      + (row.TEMPLATE_NOME ? ` (template ${row.TEMPLATE_NOME})` : '')
      + (quando ? ` enviado em ${quando}.` : '.') + dados;
    await conn.execute(
      `INSERT INTO mensagem (conversa_id, contato_id, direcao, tipo, conteudo, ts)
       VALUES (:cv, :ct, 'nota', 'text', :txt, :ts)`,
      { cv: conversaId, ct: contatoId, txt: texto, ts: row.ENVIADO_EM || new Date() }
    );
  } catch (err) {
    console.error('[webhook] nota de resposta de campanha falhou:', err.message);
  }
}

/** Processa UMA change (já com o tenant/número resolvidos) dentro de comTenant().
    Devolve a lista de eventos a publicar/despachar depois do commit. */
async function processChange(conn, numero, value) {
  const meta = value.metadata || {};
  const numeroId = numero.id;
  const contacts = value.contacts || [];
  const eventos = [];

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
          `SELECT 1 FROM conversa
            WHERE contato_id = :cid AND status <> 'resolvida' AND COALESCE(numero_id, -1) = COALESCE(:num, -1)
            FETCH FIRST 1 ROWS ONLY`,
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
      media = await safeDownload(msg[msg.type], meta.phone_number_id, numero.tenantId);
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
        await registrarOpt(conn, {
          contatoId, telefone: msg.from, acao: optAcao, origem: 'whatsapp_inbound',
        });
        console.log(`[webhook] ${optAcao} registrado p/ contato ${contatoId} (${msg.from})`);
        if (optAcao === 'optout' && conversa.filaStatus === 'bot') {
          await conn.execute(
            `UPDATE conversa
                SET status = 'resolvida', fila_status = 'resolvida', resolvida_em = now()
              WHERE id = :id AND fila_status = 'bot'`,
            { id: conversaId }
          );
        }
      }
    }

    // Comando de ENCERRAMENTO pelo cliente (config 'comando_encerrar' em
    // Ajustes): encerra o atendimento em qualquer estado (bot/fila/humano).
    let encerrouPorComando = false;
    if (!optAcao && msg.type === 'text' && msg.text) {
      const cfgZap = await lerConfig(numero.tenantId, conn);
      const comando = String(cfgZap.comando_encerrar || '').trim();
      if (comando && normalizar(msg.text.body) === normalizar(comando)) {
        await conn.execute(
          `UPDATE conversa
              SET status = 'resolvida', fila_status = 'resolvida', resolvida_em = now()
            WHERE id = :id AND fila_status <> 'resolvida'`,
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
      const cfgFH = await lerConfig(numero.tenantId, conn); // cache de 60s
      if (foraDeHorario(cfgFH, ts) && String(cfgFH.fora_horario_msg || '').trim()) {
        await conn.execute(
          `UPDATE conversa SET aviso_fora_horario = 'S' WHERE id = :id`, { id: conversaId });
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

  return eventos;
}

/** Processa um payload bruto do webhook (objeto já parseado). Idempotente. */
async function processPayload(payload) {
  const entries = payload.entry || [];
  const eventosGlobais = [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const meta = value.metadata || {};
      const numero = await resolverNumero(meta.phone_number_id);
      if (!numero) {
        // phone_number_id não provisionado para nenhum tenant: IGNORA o evento
        // por completo — nunca cria conversa órfã nem adivinha um tenant dono.
        console.warn(`[webhook] phone_number_id desconhecido (${meta.phone_number_id || 'vazio'}) — evento ignorado`);
        continue;
      }
      // Cada change roda na sua PRÓPRIA transação tenant-scoped: commit no
      // sucesso, rollback no erro (comTenant), sem misturar tenants na mesma tx.
      const eventos = await db.comTenant(numero.tenantId, (conn) => processChange(conn, numero, value));
      for (const evt of eventos) eventosGlobais.push({ ...evt, tenantId: numero.tenantId });
    }
  }

  // Só notifica os clientes (SSE) depois de persistir com sucesso.
  // Eventos bot_* são internos: viram chamadas ao runtime (isolado, pós-commit).
  const runtime = require('../bot/runtime');
  for (const evt of eventosGlobais) {
    if (evt.tipo === 'bot_iniciar') { runtime.iniciarFluxo(evt.tenantId, evt.conversaId); continue; }
    if (evt.tipo === 'bot_entrada') { runtime.processarEntrada(evt.tenantId, evt.conversaId, evt.texto); continue; }
    if (evt.tipo === 'ia_entrada') { require('../ia/runtime').processarEntrada(evt.tenantId, evt.conversaId, evt.texto); continue; }
    if (evt.tipo === 'encerrar_cliente') {
      confirmarEncerramento(evt); // envia a confirmação fora da tx (isolado)
      publish({ tipo: 'conversa', conversaId: evt.conversaId, departamentoId: evt.departamentoId, tenantId: evt.tenantId });
      continue;
    }
    if (evt.tipo === 'fora_horario') { enviarAvisoForaHorario(evt); continue; }
    publish(evt);
    // Conversa nova na fila → tenta distribuir (fora da transação do webhook).
    if (evt.tipo === 'fila') distribuidor.atribuir(evt.departamentoId);
  }
}

module.exports = { processPayload };
