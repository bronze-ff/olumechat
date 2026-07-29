// webhook/efeitoStore.js — OUTBOX dos efeitos pós-commit do webhook
// (FIL-94, achado P1-1 da review cruzada do PR #40).
//
// ── O FURO QUE ISTO FECHA ───────────────────────────────────────────────────
// A durabilidade do evento bruto (023) não bastava. O pipeline do webhook
// commita a transação do change e SÓ DEPOIS despacha os efeitos pós-commit
// (saudação do bot, entrada da IA, distribuição de fila, SSE, aviso de fora de
// horário, confirmação de encerramento). Morrer nesse intervalo era perda
// silenciosa: no replay, o dedup por WAMID (`mensagem (tenant_id, wamid)`)
// pula a mensagem, nenhum efeito é produzido, e o evento era marcado
// `concluido` — o cliente ficava SEM RESPOSTA AUTOMÁTICA exatamente no cenário
// que o ticket existe para cobrir.
//
// Correção: os efeitos são PERSISTIDOS na MESMA transação do change (por isso
// `gravar()` recebe a `conn` do comTenant() em curso — commitam junto com a
// mensagem, ou nada acontece). O dispatcher consome FORA da transação e marca
// cada efeito como despachado individualmente; o replay despacha o que sobrou
// mesmo quando o WAMID já existe. Um evento só vira `concluido` quando não há
// efeito pendente (guarda no SQL do eventoStore::concluir).
//
// ── TABELA DE TENANT, DIFERENTE DA 023 ─────────────────────────────────────
// `webhook_evento` é global porque o evento chega antes de existir tenant.
// O EFEITO é o oposto: nasce dentro do comTenant() do change, sempre com um
// tenant conhecido, e carrega dado de tenant (conversa, departamento, texto).
// Então `webhook_efeito` é tabela normal, no bloco `isolamento_tenant`
// (migração 024) com `tenant_id` vindo do DEFAULT `tenant_atual()` — o JS NUNCA
// escreve o tenant_id, para não existir a possibilidade de efeito nascer em
// tenant divergente do change que o gerou.
//
// ⚠️ AT-LEAST-ONCE, DE PROPÓSITO. Despachamos e SÓ DEPOIS marcamos. Morrer
// nessa janela (um round trip) redispara o efeito; a ordem inversa PERDERIA o
// efeito. Entre duplicar uma saudação e deixar o cliente no silêncio, este repo
// já escolheu: "erro de envio não pode virar silêncio pro cliente final"
// (server/AGENTS.md). SSE e distribuição de fila são idempotentes; bot/IA podem,
// no pior caso, responder duas vezes.
//
// ⚠️ `payload` é text (JSON), não jsonb — MESMO motivo da 023: jsonb rejeita
// `\u0000` dentro de string, e o texto do cliente entra aqui (bot_entrada,
// fora_horario, ia_entrada). Um escape desses viraria falha de transação no
// meio da ingestão.
//
// Fora de `gravar()`, toda função abre e devolve a própria conexão (statement
// único, autoCommit) — o dispatcher não pode segurar conexão do pool enquanto
// despacha (regra de ouro nº 4 do AGENTS.md).
'use strict';

const db = require('./../db/pool');

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
 * Persiste os efeitos pós-commit de UM change — DENTRO da transação dele.
 * @param {object} conn conexão do comTenant() em curso (não abre outra)
 * @param {{eventoId: number, efeitos: object[]}} dados
 */
async function gravar(conn, { eventoId, efeitos }) {
  if (!eventoId || !efeitos || !efeitos.length) return 0;
  for (const efeito of efeitos) {
    await conn.execute(
      `INSERT INTO webhook_efeito (evento_id, tipo, payload)
       VALUES (:ev, :tipo, :payload)`,
      {
        ev: eventoId,
        tipo: String(efeito.tipo || 'desconhecido').slice(0, 30),
        payload: JSON.stringify(efeito),
      }
    );
  }
  return efeitos.length;
}

/** Efeitos ainda não despachados de um evento, na ordem em que nasceram
    (efeito fora de ordem muda o que o cliente recebe). `payload` volta como
    TEXTO — quem despacha decide o que fazer com um JSON ilegível. */
async function pendentes(eventoId) {
  const r = await executar(
    `SELECT id, tenant_id, tipo, payload
       FROM webhook_efeito
      WHERE evento_id = :ev AND despachado_em IS NULL
      ORDER BY id`,
    { ev: eventoId }
  );
  return (r.rows || []).map((l) => ({
    id: l.ID, tenantId: l.TENANT_ID, tipo: l.TIPO, payload: l.PAYLOAD,
  }));
}

/**
 * Marca UM efeito como despachado. `tenant_id` explícito no WHERE porque esta
 * query roda no caminho de sistema (conexão dona, BYPASSRLS) — mesma disciplina
 * do operador/db.js. `despachado_em IS NULL` faz a marcação ser idempotente.
 * @returns {Promise<boolean>} true = esta chamada marcou
 */
async function marcarDespachado(id, tenantId) {
  const r = await executar(
    `UPDATE webhook_efeito
        SET despachado_em = now()
      WHERE id = :id AND tenant_id = :tid AND despachado_em IS NULL
      RETURNING id`,
    { id, tid: tenantId }
  );
  return Boolean((r.rows || []).length);
}

/**
 * Retenção: apaga os efeitos dos eventos já `concluido` fora da janela — roda
 * ANTES do purge dos eventos (webhook/durabilidade.js) para não deixar efeito
 * órfão. Não há FK para `webhook_evento` de propósito: é tabela de tenant
 * apontando para tabela de sistema, e uma FK aí faria o INSERT de toda mensagem
 * recebida depender de checagem de integridade contra uma tabela sem GRANT para
 * `falatta_app` — risco desnecessário no caminho mais quente do produto.
 * @returns {Promise<number>} linhas apagadas
 */
async function purgarDeEventosConcluidos(dias) {
  const r = await executar(
    `DELETE FROM webhook_efeito
      WHERE evento_id IN (
        SELECT id FROM webhook_evento
         WHERE estado = 'concluido'
           AND concluido_em <= now() - make_interval(days => :dias)
      )`,
    { dias }
  );
  return r.rowsAffected || 0;
}

module.exports = { gravar, pendentes, marcarDespachado, purgarDeEventosConcluidos };
