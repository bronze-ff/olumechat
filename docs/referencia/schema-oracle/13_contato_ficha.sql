-- ============================================================================
-- MC-ZAP — Ficha do contato: identificação interna (apelido, CNPJ, obs, tags).
-- Rodar como MCLABS, DEPOIS do 12_backfill_depto_ativas.sql.
-- (Script portável: sem comandos SQL*Plus.)
-- IDEMPOTENCIA: NAO eh idempotente (rodar 2x gera erro). REQUER Oracle 12c+.
--
-- Objetivo: o contato chega com o NOME_PERFIL do WhatsApp (ex.: "somente
-- wattzap"), que não identifica o cliente. Aqui a gente passa a poder gravar,
-- NO CONTATO (vale para TODAS as conversas daquele telefone): um nome interno,
-- observações e tags. CODCLI e CGCENT (CNPJ) já existem na tabela — a ficha
-- também passa a preenchê-los (manual ou pela auto-identificação na chegada).
-- ============================================================================

ALTER TABLE MC_ZAP_CONTATO ADD (
  NOME_INTERNO   VARCHAR2(200),    -- apelido/razão social que a gente define (exibido no lugar do nome do WhatsApp)
  OBSERVACOES    VARCHAR2(2000),   -- anotações livres sobre o contato
  TAGS_CONTATO   VARCHAR2(1000),   -- JSON: array de IDs de MC_ZAP_TAG (etiquetas coladas no contato)
  ATUALIZADO_POR NUMBER,           -- atendente que editou a ficha por último (auditoria "editado por")
  ATUALIZADO_EM  TIMESTAMP,        -- quando ("editado em")
  CONSTRAINT CK_MCZAP_CONTATO_TAGSC CHECK (TAGS_CONTATO IS NULL OR TAGS_CONTATO IS JSON),
  CONSTRAINT FK_MCZAP_CONTATO_ATD FOREIGN KEY (ATUALIZADO_POR) REFERENCES MC_ZAP_ATENDENTE (ID)
);

-- Índice para a auto-identificação reversa não impactar buscas por CODCLI já vinculado.
CREATE INDEX IX_MCZAP_CONTATO_CGCENT ON MC_ZAP_CONTATO (CGCENT);

-- Verificação.
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH FROM USER_TAB_COLUMNS
 WHERE TABLE_NAME = 'MC_ZAP_CONTATO'
   AND COLUMN_NAME IN ('NOME_INTERNO','OBSERVACOES','TAGS_CONTATO','ATUALIZADO_POR','ATUALIZADO_EM')
 ORDER BY COLUMN_NAME;
