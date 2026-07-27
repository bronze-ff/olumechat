-- ============================================================================
-- apagar_conversas_sem_departamento.sql
-- Remove todas as conversas (e mensagens) sem departamento vinculado.
-- Essas são as conversas criadas antes da Fase 5A (sem DEPARTAMENTO_ID),
-- que aparecem em todos os departamentos na tela de atendimento.
--
-- ANTES DE RODAR: execute o bloco de PREVIEW abaixo para conferir os totais.
-- COMO RODAR: SQL Developer (F5) ou PL/SQL Developer (Command Window / F8).
-- SCHEMA: rode conectado como MCLABS.
-- ============================================================================


-- ============================================================================
-- PASSO 1 — PREVIEW: confira quantos registros serão apagados
-- ============================================================================
SELECT
  (SELECT COUNT(*) FROM MC_ZAP_CONVERSA  WHERE DEPARTAMENTO_ID IS NULL) AS CONVERSAS_SEM_DEPTO,
  (SELECT COUNT(*) FROM MC_ZAP_MENSAGEM  WHERE CONVERSA_ID IN
     (SELECT ID FROM MC_ZAP_CONVERSA WHERE DEPARTAMENTO_ID IS NULL))     AS MENSAGENS_VINCULADAS,
  (SELECT COUNT(*) FROM MC_ZAP_AUDITORIA WHERE ENTIDADE = 'conversa'
     AND ENTIDADE_ID IN
     (SELECT ID FROM MC_ZAP_CONVERSA WHERE DEPARTAMENTO_ID IS NULL))     AS AUDITORIAS_VINCULADAS
FROM DUAL;


-- ============================================================================
-- PASSO 2 — EXCLUSÃO (rode apenas depois de conferir o PREVIEW acima)
-- ============================================================================

-- 2a) Apaga as mensagens das conversas sem departamento
DELETE FROM MC_ZAP_MENSAGEM
WHERE CONVERSA_ID IN (
  SELECT ID FROM MC_ZAP_CONVERSA WHERE DEPARTAMENTO_ID IS NULL
);

-- 2b) Apaga registros de auditoria vinculados a essas conversas
DELETE FROM MC_ZAP_AUDITORIA
WHERE ENTIDADE = 'conversa'
  AND ENTIDADE_ID IN (
    SELECT ID FROM MC_ZAP_CONVERSA WHERE DEPARTAMENTO_ID IS NULL
  );

-- 2c) Apaga as conversas em si
DELETE FROM MC_ZAP_CONVERSA
WHERE DEPARTAMENTO_ID IS NULL;

-- 2d) Confirma as alterações
COMMIT;

-- ============================================================================
-- PASSO 3 — VERIFICAÇÃO FINAL
-- ============================================================================
SELECT COUNT(*) AS CONVERSAS_RESTANTES FROM MC_ZAP_CONVERSA;
SELECT COUNT(*) AS CONVERSAS_SEM_DEPTO_RESTANTES
  FROM MC_ZAP_CONVERSA WHERE DEPARTAMENTO_ID IS NULL;
