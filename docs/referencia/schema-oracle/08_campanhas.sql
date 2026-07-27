-- ============================================================================
-- MC-ZAP — FASE 6: Campanha de cobrança em lote (disparo ativo).
-- Rodar como MCLABS, DEPOIS do 07_origem_permissao.sql.
-- As tabelas MC_ZAP_CAMPANHA e MC_ZAP_CAMPANHA_ITEM já existem do install base;
-- aqui só acrescentamos colunas de controle/progresso e índices.
-- (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENCIA: NAO eh idempotente (rodar 2x gera erro). REQUER Oracle 12c+.
-- ============================================================================

-- 1) Item: variáveis resolvidas do SELECT (1 por {{n}}) + tentativas.
ALTER TABLE MC_ZAP_CAMPANHA_ITEM ADD (
  VARIAVEIS  CLOB,                          -- JSON array ["v1","v2"] (ordem = {{1}},{{2}})
  TENTATIVAS NUMBER DEFAULT 0 NOT NULL
);
-- Dedup atômico no "preparar": um telefone só entra uma vez por campanha.
ALTER TABLE MC_ZAP_CAMPANHA_ITEM ADD CONSTRAINT UQ_MCZAP_CI_CAMP_TEL UNIQUE (CAMPANHA_ID, TELEFONE);
CREATE INDEX IX_MCZAP_CI_WAMID    ON MC_ZAP_CAMPANHA_ITEM (WAMID);
CREATE INDEX IX_MCZAP_CI_DISPATCH ON MC_ZAP_CAMPANHA_ITEM (CAMPANHA_ID, STATUS);

-- 2) Campanha: snapshot do template, progresso e parâmetros de disparo.
ALTER TABLE MC_ZAP_CAMPANHA ADD (
  TEMPLATE_NOME VARCHAR2(120),
  LANG          VARCHAR2(10) DEFAULT 'pt_BR',
  TOTAL         NUMBER DEFAULT 0 NOT NULL,
  ENVIADOS      NUMBER DEFAULT 0 NOT NULL,
  RATE_POR_SEG  NUMBER DEFAULT 10 NOT NULL,
  JANELA_INICIO VARCHAR2(5) DEFAULT '08:00' NOT NULL,
  JANELA_FIM    VARCHAR2(5) DEFAULT '20:00' NOT NULL,
  PAUSA_MOTIVO  VARCHAR2(200),
  RETOMA_EM     TIMESTAMP,
  ATUALIZADO_EM TIMESTAMP
);

-- 3) Número: teto diário de destinatários (Meta começa número novo em ~250/dia).
ALTER TABLE MC_ZAP_NUMERO ADD ( LIMITE_DIARIO NUMBER DEFAULT 250 NOT NULL );

-- 4) Verificação.
SELECT object_name, status FROM user_objects WHERE object_name IN ('MC_ZAP_CAMPANHA','MC_ZAP_CAMPANHA_ITEM');
SELECT COLUMN_NAME FROM USER_TAB_COLUMNS
 WHERE (TABLE_NAME = 'MC_ZAP_CAMPANHA'      AND COLUMN_NAME IN ('TEMPLATE_NOME','RATE_POR_SEG','JANELA_INICIO'))
    OR (TABLE_NAME = 'MC_ZAP_CAMPANHA_ITEM' AND COLUMN_NAME IN ('VARIAVEIS','TENTATIVAS'))
    OR (TABLE_NAME = 'MC_ZAP_NUMERO'        AND COLUMN_NAME = 'LIMITE_DIARIO')
 ORDER BY COLUMN_NAME;
