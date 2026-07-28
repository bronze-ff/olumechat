-- ============================================================================
-- 019_consumo_custo_incompleto.sql — achado de review do PR #25 (FIL-76): o
-- fechamento mensal (server/consumo/fechamento.js::fecharMes, 016) usava
-- `COALESCE(SUM(custo_centavos), 0)`. Quando um evento tinha custo
-- desconhecido (custo_centavos IS NULL — preço do provider/modelo ainda não
-- cadastrado no momento do evento, ver consumo/registrar.js), o SUM ignorava
-- a linha e o COALESCE convertia "não sei quanto custou" em um ZERO exato.
-- Como `consumo_mensal` é permanente e o bruto (`consumo_evento`) é apagado
-- depois de 90 dias (retenção), esse zero falso vira definitivo — não tem
-- como corrigir depois.
--
-- Este arquivo só adiciona a coluna que marca "este agregado tem custo
-- incompleto" (`bool_or(custo_centavos IS NULL)` por grupo, calculado em
-- fecharMes). O NÚMERO em `custo_centavos` continua sendo a soma do que É
-- conhecido — nunca inventamos um valor —, mas agora existe um jeito de
-- distinguir "custou exatamente R$0,00" de "não sabemos quanto custou parte
-- disso" antes do faturamento (FIL-79) usar este agregado.
--
-- IDEMPOTENTE: pode rodar mais de uma vez. Nunca edite este arquivo depois de
-- aplicado em um ambiente compartilhado — mudança de schema é migração nova.
-- ============================================================================

ALTER TABLE consumo_mensal
  ADD COLUMN IF NOT EXISTS custo_incompleto boolean NOT NULL DEFAULT false;
