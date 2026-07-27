-- ============================================================================
-- MC-ZAP — ATALHOS (respostas rápidas com "/" no composer).
-- Rodar como MCLABS, DEPOIS do 05_config.sql.
-- (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENCIA: NAO eh idempotente (rodar 2x gera erro). REQUER Oracle 12c+.
-- ============================================================================

-- A tabela MC_ZAP_RESPOSTA_RAPIDA ja existe desde o install original.
-- Ganha ESCOPO: 'pessoal' (so o criador ve) ou 'departamento' (toda a fila ve).
ALTER TABLE MC_ZAP_RESPOSTA_RAPIDA ADD (
  ESCOPO          VARCHAR2(15) DEFAULT 'pessoal' NOT NULL,
  DEPARTAMENTO_ID NUMBER,
  CONSTRAINT CK_MCZAP_RR_ESCOPO CHECK (ESCOPO IN ('pessoal','departamento')),
  CONSTRAINT FK_MCZAP_RR_DEPTO FOREIGN KEY (DEPARTAMENTO_ID)
    REFERENCES MC_ZAP_DEPARTAMENTO (ID)
);

-- Verificacao.
SELECT COLUMN_NAME FROM USER_TAB_COLUMNS
 WHERE TABLE_NAME = 'MC_ZAP_RESPOSTA_RAPIDA'
 ORDER BY COLUMN_ID;
