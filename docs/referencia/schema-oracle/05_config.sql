-- ============================================================================
-- MC-ZAP — CONFIGURACOES DO PAINEL (chave/valor).
-- Rodar como MCLABS, DEPOIS do 04_fase5c.sql.
-- (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENCIA: NAO eh idempotente (rodar 2x gera erro). REQUER Oracle 12c+.
-- ============================================================================

-- 1) Configuracoes gerais editaveis pelo ADMIN no painel (ex.: mensagem padrao
--    de despedida ao encerrar atendimento). Novas chaves nao exigem DDL.
CREATE TABLE MC_ZAP_CONFIG (
  CHAVE         VARCHAR2(60) NOT NULL,
  VALOR         VARCHAR2(2000),
  ATUALIZADO_EM TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT PK_MCZAP_CONFIG PRIMARY KEY (CHAVE)
);

-- 2) Seed: despedida padrao do encerramento (o atendente pode editar antes de
--    enviar; {{protocolo}} eh substituido pelo protocolo da conversa).
INSERT INTO MC_ZAP_CONFIG (CHAVE, VALOR) VALUES (
  'despedida_padrao',
  'Atendimento encerrado. Guarde seu protocolo: {{protocolo}}.' || CHR(10) ||
  'Precisou de novo, e so mandar uma mensagem por aqui. Obrigado!'
);
COMMIT;

-- 3) Verificacao.
SELECT CHAVE, VALOR FROM MC_ZAP_CONFIG;
