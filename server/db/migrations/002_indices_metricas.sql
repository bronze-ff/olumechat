-- ============================================================================
-- 002_indices_metricas.sql — índices que sustentam as agregações do dashboard
-- (server/api/metricas.js, ticket FIL-65).
--
-- A migração 001 já cobre contato_id/status/atendente_id/fila+departamento em
-- `conversa`, mas nenhum índice tem `criado_em` — e é exatamente o que toda
-- query de server/api/metricas.js filtra (período) e agrupa (quebra por dia).
-- Sem isso, /api/metricas/resumo faz sequential scan em `conversa` assim que
-- houver mais de um punhado de tenants.
--
-- `tenant_id` como PRIMEIRA coluna (padrão do schema — ver 001). Parcial em
-- `protocolo IS NOT NULL` porque é a condição fixa de toda query do módulo
-- (só atendimentos de fila/bot entram nas métricas — mensagens avulsas fora
-- de fila, se um dia existirem, não contam) — deixa o índice menor e mais
-- seletivo do que um índice cobrindo a tabela inteira.
--
-- IDEMPOTENTE: CREATE INDEX IF NOT EXISTS.
-- ============================================================================

CREATE INDEX IF NOT EXISTS ix_conv_tenant_criado
  ON conversa (tenant_id, criado_em)
  WHERE protocolo IS NOT NULL;
