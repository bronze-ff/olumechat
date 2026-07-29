// webhook/eventoStore.js — persistência do EVENTO BRUTO da Meta (FIL-94,
// docs/DEPLOY_VPS.md §P0.6). É a camada que faz a entrada do webhook sobreviver
// a um restart: o payload é gravado ANTES do ACK e o processamento passa a ser
// uma máquina de estados no banco, não uma promessa em memória.
//
// ── POR QUE ESTA TABELA É GLOBAL (SEM tenant_id) ────────────────────────────
// A Meta não manda tenant nenhum — quem sabe de quem é a mensagem é o
// `phone_number_id`, e essa resolução acontece DEPOIS, no processEvent. Um
// evento pode até trazer mais de um `phone_number_id` (entries diferentes).
// Então `webhook_evento` é uma tabela de SISTEMA, no mesmo padrão de
// `provedor_credencial` (migração 015) e `operador` (005): RLS ENABLE+FORCE com
// policy USING(false) e REVOKE de `falatta_app`. Uma rota de tenant que
// tentasse ler daqui toma "permission denied", não uma linha vazia silenciosa.
// O isolamento entre empresas continua ONDE SEMPRE ESTEVE: nas tabelas de
// negócio, escritas dentro de db.comTenant() pelo processEvent.
//
// (Não confundir com `evento_webhook` da migração 001: aquela é tenant-scoped e
// por isso inutilizável AQUI — sem tenant resolvido, `tenant_atual()` é NULL e
// o INSERT viola o NOT NULL. Ninguém a usa; ver o cabeçalho da migração 023.)
//
// ── POR QUE `payload` É text, NÃO jsonb ────────────────────────────────────
// jsonb rejeita `\u0000` dentro de string ("unsupported Unicode escape
// sequence"). Um único evento com esse escape viraria um poison pill: o INSERT
// falha, respondemos erro recuperável, a Meta reenvia, falha de novo, para
// sempre. `text` guarda o corpo EXATAMENTE como chegou (que é o ponto de um
// log bruto) e o parse fica no consumidor, onde um payload torto derruba só
// aquele evento.
//
// ── CONCORRÊNCIA: A REIVINDICAÇÃO ATÔMICA É O LOCK ─────────────────────────
// Não há advisory lock aqui de propósito (diferente de bot/sweeper.js e
// consumo/fechamento.js). Quem "ganha" um evento é quem consegue o UPDATE com
// guarda de estado (`WHERE ... estado = 'recebido'` / janela de orfandade):
// duas instâncias — ou o caminho inline e a recuperação — nunca processam o
// mesmo evento, porque só um UPDATE afeta linha. Isso é mais forte que o lock
// de liderança (que só evita dois ticks simultâneos) e não exige segurar
// conexão do pool durante o processamento (regra de ouro nº 4 do AGENTS.md).
//
// Toda função aqui é UM statement com autoCommit, abrindo e devolvendo a
// conexão na hora — nada de transação aberta enquanto o evento é processado.
'use strict';

const crypto = require('crypto');
const db = require('./../db/pool');

const MAX_ERRO = 2000;

/** SELECT/UPDATE/DELETE de um único statement, conexão devolvida na saída. */
async function executar(sql, binds) {
  const conn = await db.getConnection();
  try {
    return await conn.execute(sql, binds, { autoCommit: true });
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Chave idempotente do evento — derivada dos IDENTIFICADORES DA META, não dos
 * bytes recebidos: a reentrega do mesmo evento colapsa mesmo que a Meta mude
 * espaçamento/ordem de campos, e um evento novo nunca colapsa com o anterior.
 *
 * O status entra com `status` + `timestamp` porque `sent`, `delivered` e `read`
 * do MESMO wamid são três eventos distintos e todos precisam ser processados.
 * Payload sem mensagem nem status (alerta de conta, campo novo da Meta) cai no
 * hash do corpo bruto — é o melhor identificador disponível ali.
 *
 * Só o HASH é guardado: a chave nunca carrega texto do cliente (ela vive em
 * índice e em log de erro).
 * @param {Buffer|string} rawBody corpo exatamente como chegou
 * @param {object} payload mesmo corpo já parseado
 * @returns {string} `ev:<sha256>` ou `raw:<sha256>` (67 chars)
 */
function chaveIdempotente(rawBody, payload) {
  const ids = [];
  for (const entry of (payload && payload.entry) || []) {
    for (const change of (entry && entry.changes) || []) {
      const value = (change && change.value) || {};
      for (const m of value.messages || []) if (m && m.id) ids.push(`m:${m.id}`);
      for (const s of value.statuses || []) {
        if (s && s.id) ids.push(`s:${s.id}:${s.status || ''}:${s.timestamp || ''}`);
      }
    }
  }
  if (ids.length) return 'ev:' + sha256(ids.join('|'));
  const corpo = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody));
  return 'raw:' + sha256(corpo);
}

function sha256(valor) {
  return crypto.createHash('sha256').update(valor).digest('hex');
}

/** Primeiro `phone_number_id` do payload — só para triagem/log (um evento pode
    trazer mais de um; quem manda de verdade é o payload gravado). */
function primeiroPhoneNumberId(payload) {
  for (const entry of (payload && payload.entry) || []) {
    for (const change of (entry && entry.changes) || []) {
      const id = change && change.value && change.value.metadata
        && change.value.metadata.phone_number_id;
      if (id) return String(id).slice(0, 60);
    }
  }
  return null;
}

/**
 * Grava o evento bruto. Reentrega da Meta (mesma chave) NÃO insere de novo:
 * o `ON CONFLICT DO NOTHING` devolve zero linhas e sinalizamos `duplicado`.
 * Não buscamos o id da linha existente de propósito — quem recebe duplicado só
 * precisa dar ACK, e um segundo SELECT no caminho crítico do webhook custaria
 * latência sem servir para nada.
 * @returns {Promise<{id: number|null, duplicado: boolean}>}
 */
async function persistir({ rawBody, payload, phoneNumberId }) {
  const r = await executar(
    `INSERT INTO webhook_evento (chave_idempotente, payload, phone_number_id)
     VALUES (:chave, :payload, :phone)
     ON CONFLICT (chave_idempotente) DO NOTHING
     RETURNING id`,
    {
      chave: chaveIdempotente(rawBody, payload),
      payload: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody == null ? '' : rawBody),
      phone: phoneNumberId || primeiroPhoneNumberId(payload),
    }
  );
  const linha = (r.rows || [])[0];
  return linha ? { id: linha.ID, duplicado: false } : { id: null, duplicado: true };
}

/**
 * Reivindica um evento RECÉM-PERSISTIDO (caminho inline, logo após o ACK).
 * A guarda `estado = 'recebido' AND tentativas = 0` é estreita de propósito:
 * este caminho nunca "rouba" um evento que a recuperação já pegou.
 * @returns {Promise<boolean>} true = este processo é o dono
 */
async function reivindicarNovo(id) {
  const r = await executar(
    `UPDATE webhook_evento
        SET estado = 'processando', tentativas = tentativas + 1, tentado_em = now()
      WHERE id = :id AND estado = 'recebido' AND tentativas = 0
      RETURNING id`,
    { id }
  );
  return Boolean((r.rows || []).length);
}

/**
 * Reivindica um evento ÓRFÃO (o processo morreu no meio, ou a tentativa
 * anterior falhou). A janela de orfandade é repetida AQUI, e não só na busca
 * dos candidatos: entre o SELECT e o UPDATE outra instância pode ter pegado o
 * mesmo evento — a guarda no UPDATE é o que resolve a corrida.
 * @returns {Promise<boolean>}
 */
async function reivindicarOrfao(id, orfaoMin) {
  const r = await executar(
    `UPDATE webhook_evento
        SET estado = 'processando', tentativas = tentativas + 1, tentado_em = now()
      WHERE id = :id AND estado IN ('recebido', 'processando')
        AND COALESCE(tentado_em, recebido_em) <= now() - make_interval(mins => :orfaoMin)
      RETURNING id`,
    { id, orfaoMin }
  );
  return Boolean((r.rows || []).length);
}

/**
 * Fecha o evento e devolve o ATRASO total (chegada → conclusão), medido pelo
 * banco — é a base do alerta de "atraso no webhook" (§9 do plano).
 *
 * ⚠️ A guarda `NOT EXISTS (efeito pendente)` é o que dá sentido ao estado
 * `concluido` (achado P1-1 da review): não basta os changes terem commitado, os
 * efeitos pós-commit (saudação do bot, entrada da IA, fila, SSE) precisam ter
 * sido despachados. Sem ela, um evento cujo dispatch morreu no meio seria
 * fechado como sucesso e o cliente ficaria sem resposta automática. Fica no SQL,
 * e não no fluxo do JS, para valer também para o caminho novo que esquecer disso.
 * @returns {Promise<{atrasoMs: number|null, concluido: boolean}>}
 */
async function concluir(id) {
  const r = await executar(
    `UPDATE webhook_evento
        SET estado = 'concluido', concluido_em = now(), erro = NULL
      WHERE id = :id
        AND NOT EXISTS (
          SELECT 1 FROM webhook_efeito e
           WHERE e.evento_id = webhook_evento.id AND e.despachado_em IS NULL
        )
      RETURNING (EXTRACT(EPOCH FROM (now() - recebido_em)) * 1000)::bigint AS atraso_ms`,
    { id }
  );
  const linha = (r.rows || [])[0];
  return { atrasoMs: linha ? Number(linha.ATRASO_MS) : null, concluido: Boolean(linha) };
}

/**
 * Finaliza os ENCALHADOS: eventos parados que já esgotaram as tentativas de
 * PROCESSAMENTO. Complemento (não sobreposição) de `candidatosOrfaos`, que só
 * pega `tentativas < max`.
 *
 * ⚠️ Achado P2-3 da review: sem isto, `processando` com `tentativas == max` +
 * uma falha transitória na FINALIZAÇÃO (o UPDATE de concluir/falhar caiu) ficava
 * fora dos dois caminhos — nem retry, nem falha definitiva. Era um estado
 * terminal implícito: a linha ficava pendente para sempre, contando no gauge de
 * "evento sem conclusão" sem ninguém nunca resolvê-la. A finalização tem que ser
 * independente do limite de tentativas de processamento.
 *
 * O UPDATE também RECLAMA os eventos (viram `falhou` na mesma passada), então
 * outra instância não os pega em paralelo — e os efeitos já commitados que
 * sobrarem ainda podem ser despachados depois (ver webhook/durabilidade.js).
 * @returns {Promise<number[]>} ids finalizados
 */
async function finalizarEncalhados({ orfaoMin, maxTentativas, limite, motivo }) {
  const r = await executar(
    `UPDATE webhook_evento
        SET estado = 'falhou',
            erro = left(COALESCE(erro || ' | ', '') || :motivo, ${MAX_ERRO})
      WHERE id IN (
        SELECT id FROM webhook_evento
         WHERE estado IN ('recebido', 'processando')
           AND tentativas >= :max
           AND COALESCE(tentado_em, recebido_em) <= now() - make_interval(mins => :orfaoMin)
         ORDER BY recebido_em
         LIMIT :limite
      )
      RETURNING id`,
    { orfaoMin, max: maxTentativas, limite, motivo: String(motivo || 'finalizado pela recuperação').slice(0, 200) }
  );
  return (r.rows || []).map((l) => l.ID);
}

/**
 * Registra a falha do processamento. Abaixo do limite volta para `recebido`
 * (a recuperação tenta de novo); no limite fica `falhou` — falha DEFINITIVA,
 * que continua no banco com o payload e o erro para investigação (nunca é
 * apagada pela retenção, que só toca em `concluido`).
 * @returns {Promise<{estado: string, tentativas: number, definitivo: boolean}>}
 */
async function falhar(id, erro, maxTentativas) {
  const r = await executar(
    `UPDATE webhook_evento
        SET estado = CASE WHEN tentativas >= :max THEN 'falhou' ELSE 'recebido' END,
            erro = :erro
      WHERE id = :id AND estado <> 'concluido'
      RETURNING estado, tentativas`,
    { id, max: maxTentativas, erro: String((erro && erro.message) || erro || 'erro sem mensagem').slice(0, MAX_ERRO) }
  );
  const linha = (r.rows || [])[0] || {};
  return {
    estado: linha.ESTADO || null,
    tentativas: linha.TENTATIVAS == null ? null : Number(linha.TENTATIVAS),
    definitivo: linha.ESTADO === 'falhou',
  };
}

/** Eventos parados: não concluídos, mais velhos que a janela de orfandade e
    ainda dentro do limite de tentativas. `LIMIT` (não FETCH FIRST) porque aqui
    o teto vem por bind. */
async function candidatosOrfaos({ orfaoMin, maxTentativas, limite }) {
  const r = await executar(
    `SELECT id, payload, tentativas
       FROM webhook_evento
      WHERE estado IN ('recebido', 'processando')
        AND tentativas < :max
        AND COALESCE(tentado_em, recebido_em) <= now() - make_interval(mins => :orfaoMin)
      ORDER BY recebido_em
      LIMIT :limite`,
    { orfaoMin, max: maxTentativas, limite }
  );
  return (r.rows || []).map((l) => ({ id: l.ID, payload: l.PAYLOAD, tentativas: Number(l.TENTATIVAS) }));
}

/** Gauge para o alerta "evento persistido sem conclusão" (§9): quantos estão
    pendentes, a idade do mais antigo e quantas falhas definitivas existem. */
async function pendentes() {
  const r = await executar(
    `SELECT count(*) FILTER (WHERE estado IN ('recebido', 'processando'))::int AS total,
            COALESCE(MAX(EXTRACT(EPOCH FROM (now() - recebido_em)))
                     FILTER (WHERE estado IN ('recebido', 'processando')), 0)::int AS mais_antigo_seg,
            count(*) FILTER (WHERE estado = 'falhou')::int AS falhas
       FROM webhook_evento`,
    {}
  );
  const l = (r.rows || [])[0] || {};
  return { total: Number(l.TOTAL || 0), maisAntigoSeg: Number(l.MAIS_ANTIGO_SEG || 0), falhas: Number(l.FALHAS || 0) };
}

/**
 * Retenção: apaga SÓ evento já `concluido` fora da janela. O payload bruto
 * carrega mensagem de cliente (LGPD) e cresce sem teto — guardar para sempre
 * seria um problema de disco e de privacidade. `falhou` e pendentes ficam.
 * @returns {Promise<number>} linhas apagadas
 */
async function purgarConcluidos(dias) {
  const r = await executar(
    `DELETE FROM webhook_evento
      WHERE estado = 'concluido'
        AND concluido_em <= now() - make_interval(days => :dias)`,
    { dias }
  );
  return r.rowsAffected || 0;
}

module.exports = {
  chaveIdempotente,
  primeiroPhoneNumberId,
  persistir,
  reivindicarNovo,
  reivindicarOrfao,
  concluir,
  falhar,
  finalizarEncalhados,
  candidatosOrfaos,
  pendentes,
  purgarConcluidos,
};
