-- ============================================================================
-- MC-ZAP — Acesso por NÚMERO por atendente.
-- Rodar como MCLABS. (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENCIA: NAO eh idempotente (rodar 2x gera erro).
--
-- Permite restringir quais números (canais) cada atendente atende — tanto para
-- RECEBER na fila quanto para ENVIAR. Ex.: Cobrança com 1061 (ativo) e 1090
-- (receptivo): o atendente receptivo recebe só conversas do 1090, e os ativos
-- só do 1061. REGRA: atendente SEM nenhuma linha aqui = acesso a TODOS os
-- números (sem restrição) — assim nada muda para quem já está configurado.
-- ============================================================================

CREATE TABLE MC_ZAP_ATENDENTE_NUMERO (
  ATENDENTE_ID NUMBER NOT NULL,
  NUMERO_ID    NUMBER NOT NULL,
  CONSTRAINT PK_MCZAP_ATD_NUM PRIMARY KEY (ATENDENTE_ID, NUMERO_ID),
  CONSTRAINT FK_MCZAP_AN_ATD FOREIGN KEY (ATENDENTE_ID) REFERENCES MC_ZAP_ATENDENTE (ID),
  CONSTRAINT FK_MCZAP_AN_NUM FOREIGN KEY (NUMERO_ID)    REFERENCES MC_ZAP_NUMERO (ID)
);
CREATE INDEX IX_MCZAP_AN_NUM ON MC_ZAP_ATENDENTE_NUMERO (NUMERO_ID);

-- Verificação.
SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME = 'MC_ZAP_ATENDENTE_NUMERO';
