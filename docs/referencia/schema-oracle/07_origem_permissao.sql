-- ============================================================================
-- MC-ZAP — Origem da conversa (ativa/receptiva) + permissão de conversa ativa.
-- Rodar como MCLABS, DEPOIS do 06_atalhos.sql.
-- (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENCIA: NAO eh idempotente (rodar 2x gera erro). REQUER Oracle 12c+.
-- ============================================================================

-- 1) Origem do atendimento:
--    'receptiva' = cliente iniciou (mensagem recebida)
--    'ativa'     = empresa iniciou (template/cobrança disparada)
ALTER TABLE MC_ZAP_CONVERSA ADD (
  ORIGEM VARCHAR2(12) DEFAULT 'receptiva' NOT NULL,
  CONSTRAINT CK_MCZAP_CONV_ORIGEM CHECK (ORIGEM IN ('receptiva','ativa'))
);

-- 2) Permissão por atendente para INICIAR conversa ativa (disparo é pago).
--    Padrão 'N' = não pode; ADMIN sempre pode. Liberado no painel (Atendentes).
ALTER TABLE MC_ZAP_ATENDENTE ADD (
  PODE_ATIVO CHAR(1) DEFAULT 'N' NOT NULL,
  CONSTRAINT CK_MCZAP_ATD_PODEATIVO CHECK (PODE_ATIVO IN ('S','N'))
);

-- 3) Backfill: conversas que têm mensagem de saída como PRIMEIRA mensagem e
--    nenhuma de entrada antes = provavelmente ativas. (Heurística simples;
--    o histórico novo já grava ORIGEM corretamente.)
UPDATE MC_ZAP_CONVERSA c
   SET ORIGEM = 'ativa'
 WHERE EXISTS (
   SELECT 1 FROM MC_ZAP_MENSAGEM m
    WHERE m.CONVERSA_ID = c.ID AND m.DIRECAO = 'out' AND m.TIPO = 'template'
 )
 AND NOT EXISTS (
   SELECT 1 FROM MC_ZAP_MENSAGEM m
    WHERE m.CONVERSA_ID = c.ID AND m.DIRECAO = 'in'
 );
COMMIT;

-- 4) Verificação.
SELECT COLUMN_NAME FROM USER_TAB_COLUMNS
 WHERE (TABLE_NAME = 'MC_ZAP_CONVERSA' AND COLUMN_NAME = 'ORIGEM')
    OR (TABLE_NAME = 'MC_ZAP_ATENDENTE' AND COLUMN_NAME = 'PODE_ATIVO');
SELECT ORIGEM, COUNT(*) FROM MC_ZAP_CONVERSA GROUP BY ORIGEM;
