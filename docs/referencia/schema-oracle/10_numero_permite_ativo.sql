-- ============================================================================
-- MC-ZAP — Número: flag "permite conversa ativa" (campanhas e Nova Conversa).
-- Rodar como MCLABS. (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENCIA: NAO eh idempotente (rodar 2x gera erro).
--
-- Uso: com vários números na conta, só os marcados com PERMITE_ATIVO='S' podem
-- originar disparo ativo (campanha de cobrança e "Nova conversa"). Ex.: 1061
-- (cobrança) = 'S'; 1090 (atendimento receptivo/fluxo) = 'N'.
-- ============================================================================

ALTER TABLE MC_ZAP_NUMERO ADD ( PERMITE_ATIVO CHAR(1) DEFAULT 'S' NOT NULL );
ALTER TABLE MC_ZAP_NUMERO ADD CONSTRAINT CK_MCZAP_NUM_PERMATIVO CHECK (PERMITE_ATIVO IN ('S','N'));

-- Sugestão pós-instalação (ajuste ao seu cenário — ou faça pela tela Números):
-- UPDATE MC_ZAP_NUMERO SET PERMITE_ATIVO = 'N' WHERE DISPLAY_PHONE LIKE '%37731090';
-- COMMIT;

-- Verificação.
SELECT COLUMN_NAME, DATA_DEFAULT FROM USER_TAB_COLUMNS
 WHERE TABLE_NAME = 'MC_ZAP_NUMERO' AND COLUMN_NAME = 'PERMITE_ATIVO';
