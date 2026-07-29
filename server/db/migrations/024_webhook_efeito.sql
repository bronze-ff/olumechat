-- ============================================================================
-- 024_webhook_efeito.sql — FIL-94 (achado P1-1 da review do PR #40): OUTBOX dos
-- efeitos pós-commit do webhook.
--
-- O QUE ESTAVA FURADO. A 023 tornou o EVENTO durável, mas não os EFEITOS. O
-- pipeline commita a transação do change e só DEPOIS despacha os efeitos
-- pós-commit (saudação do bot, entrada da IA, distribuição de fila, SSE, aviso
-- de fora de horário, confirmação de encerramento). Morrer nesse intervalo era
-- perda silenciosa: no replay, o dedup por WAMID pula a mensagem, nenhum efeito
-- é produzido e o evento seria marcado `concluido` — o cliente ficava SEM
-- RESPOSTA AUTOMÁTICA exatamente no cenário-alvo do ticket.
--
-- Agora cada efeito é uma LINHA gravada na MESMA transação do change (commita
-- junto com a mensagem, ou nada acontece). O dispatcher consome fora da
-- transação e marca um por um; o replay despacha o que sobrou mesmo com o WAMID
-- já gravado; e `webhook_evento` só vira `concluido` quando não há efeito
-- pendente (guarda no SQL — ver server/webhook/eventoStore.js::concluir).
--
-- ⚠️ TABELA DE TENANT, DIFERENTE DA 023. `webhook_evento` é global porque o
-- evento chega ANTES de existir tenant. O efeito é o oposto: nasce dentro do
-- comTenant() do change, com tenant conhecido, e carrega dado de tenant
-- (conversa, departamento, texto do cliente). Então entra no bloco
-- `isolamento_tenant` (padrão 013/016/020/021/022) com `tenant_id` vindo do
-- DEFAULT `tenant_atual()` — o JS nunca escreve tenant_id, para não existir a
-- possibilidade de efeito nascer em tenant diferente do change que o gerou.
--
-- ⚠️ SEM FK PARA `webhook_evento`, DE PROPÓSITO. Aquela é tabela de sistema com
-- REVOKE de `falatta_app`; uma FK faria o INSERT de TODA mensagem recebida
-- depender de checagem de integridade contra ela, no caminho mais quente do
-- produto. A limpeza de órfãos é explícita e roda antes do purge dos eventos
-- (server/webhook/efeitoStore.js::purgarDeEventosConcluidos).
--
-- ⚠️ `payload` é text (JSON), não jsonb — MESMO motivo da 023: jsonb rejeita
-- ` ` dentro de string e o texto do cliente entra aqui. Um escape desses
-- abortaria a transação no meio da ingestão, e aí o evento inteiro se perderia.
--
-- IDEMPOTENTE: pode rodar mais de uma vez (o deploy reaplica o histórico
-- inteiro). Nunca edite este arquivo depois de aplicado em um ambiente
-- compartilhado — mudança de schema é migração nova.
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhook_efeito (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id     bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  -- Evento bruto (webhook_evento.id) que gerou este efeito. Sem FK — ver acima.
  evento_id     bigint NOT NULL,
  tipo          varchar(30) NOT NULL,
  payload       text NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  -- NULL = ainda não despachado. É o que o dispatcher procura e o que impede o
  -- evento de ser concluído antes da hora.
  despachado_em timestamptz,
  CONSTRAINT pk_whefeito PRIMARY KEY (id),
  CONSTRAINT uq_whefeito UNIQUE (tenant_id, id)
);

-- Leitura do dispatcher: pendentes de um evento, na ordem em que nasceram.
-- Índice PARCIAL — despachado é a massa da tabela e nunca é lido por aqui.
CREATE INDEX IF NOT EXISTS ix_whefeito_pendente
  ON webhook_efeito (evento_id)
  WHERE despachado_em IS NULL;

-- Retenção (apaga por evento concluído — ver efeitoStore).
CREATE INDEX IF NOT EXISTS ix_whefeito_evento
  ON webhook_efeito (evento_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_efeito'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS isolamento_tenant ON %I', t);
    EXECUTE format(
      'CREATE POLICY isolamento_tenant ON %I '
      || 'USING (tenant_id = tenant_atual()) '
      || 'WITH CHECK (tenant_id = tenant_atual())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_efeito TO falatta_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public  TO falatta_app;
