-- ============================================================================
-- MC-ZAP — FASE 5B: Fila de atendimento, protocolo e métricas de tempo.
-- Rodar como MCLABS, DEPOIS do 02_fase5a.sql.
-- (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENCIA: NAO eh idempotente (rodar 2x gera erro). REQUER Oracle 12c+.
-- ============================================================================

-- 1) Sequence do protocolo de atendimento (formato YYMMDD + 6 dígitos).
CREATE SEQUENCE MC_ZAP_SEQ_PROTOCOLO START WITH 100000 NOCACHE;

-- 2) Conversa ganha o ciclo de vida do ATENDIMENTO (FILA_STATUS), separado do
--    STATUS atual (que segue acoplado à janela de 24h e ao webhook):
--      bot            -> em autoatendimento (Fase 5C)
--      aguardando     -> na fila do departamento, sem atendente
--      em_atendimento -> atribuída a um atendente
--      resolvida      -> atendimento encerrado (1 conversa = 1 protocolo)
--    Timestamps alimentam as métricas (espera, primeira resposta, duração).
ALTER TABLE MC_ZAP_CONVERSA ADD (
  DEPARTAMENTO_ID      NUMBER,
  FILA_STATUS          VARCHAR2(20) DEFAULT 'em_atendimento' NOT NULL,
  PROTOCOLO            VARCHAR2(14),
  FILA_ENTROU_EM       TIMESTAMP,
  ATRIBUIDA_EM         TIMESTAMP,
  PRIMEIRA_RESPOSTA_EM TIMESTAMP,
  RESOLVIDA_EM         TIMESTAMP,
  CONSTRAINT FK_MCZAP_CONV_DEPTO FOREIGN KEY (DEPARTAMENTO_ID)
    REFERENCES MC_ZAP_DEPARTAMENTO (ID),
  CONSTRAINT CK_MCZAP_CONV_FILA
    CHECK (FILA_STATUS IN ('bot','aguardando','em_atendimento','resolvida')),
  CONSTRAINT UQ_MCZAP_CONV_PROT UNIQUE (PROTOCOLO)
);
CREATE INDEX IX_MCZAP_CONV_FILA ON MC_ZAP_CONVERSA (FILA_STATUS, DEPARTAMENTO_ID);

-- 3) Backfill: conversas já resolvidas pelo fluxo antigo ficam coerentes.
UPDATE MC_ZAP_CONVERSA
   SET FILA_STATUS = 'resolvida', RESOLVIDA_EM = ULTIMA_MSG_EM
 WHERE STATUS = 'resolvida';
COMMIT;

-- 4) Verificação.
SELECT COLUMN_NAME, DATA_TYPE FROM USER_TAB_COLUMNS
 WHERE TABLE_NAME = 'MC_ZAP_CONVERSA'
   AND COLUMN_NAME IN ('DEPARTAMENTO_ID','FILA_STATUS','PROTOCOLO','FILA_ENTROU_EM',
                       'ATRIBUIDA_EM','PRIMEIRA_RESPOSTA_EM','RESOLVIDA_EM')
 ORDER BY COLUMN_NAME;
SELECT MC_ZAP_SEQ_PROTOCOLO.NEXTVAL AS TESTE_SEQ FROM DUAL;
