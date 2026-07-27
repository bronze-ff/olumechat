-- ============================================================================
-- MC-ZAP — Backfill: conversas ATIVAS que nasceram sem departamento ("Geral").
-- Rodar como MCLABS. (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENTE: pode rodar quantas vezes quiser (só afeta linhas ainda NULL).
--
-- Contexto: antes do fix, o "Nova conversa" não gravava o DEPARTAMENTO_ID, então
-- toda conversa ativa caía no inbox geral (DEPARTAMENTO_ID NULL) e ficava fora
-- das métricas/relatórios do departamento — mesmo o número tendo padrão (ex.:
-- 1061 → Cobrança). Este script corrige o que já existe, jogando cada conversa
-- ativa órfã para o DEPARTAMENTO_PADRAO_ID do número de origem.
--
-- Escopo deliberadamente restrito a ORIGEM='ativa': conversas receptivas seguem
-- outra rota (fluxo/distribuidor) e não devem ser remapeadas aqui.
-- ============================================================================

-- 1) Prévia: quantas/quais seriam corrigidas (rode antes do UPDATE).
SELECT c.ID, c.PROTOCOLO, n.NOME_EXIBICAO AS NUMERO, d.NOME AS DEPARTAMENTO_ALVO
  FROM MC_ZAP_CONVERSA c
  JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
  JOIN MC_ZAP_DEPARTAMENTO d ON d.ID = n.DEPARTAMENTO_PADRAO_ID
 WHERE c.ORIGEM = 'ativa'
   AND c.DEPARTAMENTO_ID IS NULL
   AND n.DEPARTAMENTO_PADRAO_ID IS NOT NULL
 ORDER BY c.ID;

-- 2) Correção.
UPDATE MC_ZAP_CONVERSA c
   SET c.DEPARTAMENTO_ID = (
         SELECT n.DEPARTAMENTO_PADRAO_ID FROM MC_ZAP_NUMERO n WHERE n.ID = c.NUMERO_ID )
 WHERE c.ORIGEM = 'ativa'
   AND c.DEPARTAMENTO_ID IS NULL
   AND c.NUMERO_ID IN (
         SELECT ID FROM MC_ZAP_NUMERO WHERE DEPARTAMENTO_PADRAO_ID IS NOT NULL );

COMMIT;

-- 3) Verificação: deve voltar 0 linhas.
SELECT COUNT(*) AS AINDA_NO_GERAL
  FROM MC_ZAP_CONVERSA c
  JOIN MC_ZAP_NUMERO n ON n.ID = c.NUMERO_ID
 WHERE c.ORIGEM = 'ativa'
   AND c.DEPARTAMENTO_ID IS NULL
   AND n.DEPARTAMENTO_PADRAO_ID IS NOT NULL;
