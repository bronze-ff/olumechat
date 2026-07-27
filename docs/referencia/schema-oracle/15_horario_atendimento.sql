-- ============================================================================
-- MC-ZAP — Horário de funcionamento + aviso fora de horário.
-- Rodar como MCLABS, DEPOIS do 14_contatos_duplicados.sql.
-- (Script portável: sem comandos SQL*Plus.)
-- A coluna é não-idempotente (ALTER 2x dá erro); os MERGE de config são
-- re-rodáveis (só inserem se a chave não existir).
--
-- Objetivo: quando o cliente manda mensagem fora do expediente, o sistema
-- responde UMA VEZ por conversa avisando o horário de atendimento. A flag
-- AVISO_FORA_HORARIO garante o "uma vez por conversa".
-- ============================================================================

-- 1) Flag: já avisamos esta conversa que estava fora de horário?
ALTER TABLE MC_ZAP_CONVERSA ADD ( AVISO_FORA_HORARIO CHAR(1) DEFAULT 'N' NOT NULL );
ALTER TABLE MC_ZAP_CONVERSA ADD CONSTRAINT CK_MCZAP_CONV_AVISOFH CHECK (AVISO_FORA_HORARIO IN ('S','N'));

-- 2) Configs (MERGE = não sobrescreve se já existir).
MERGE INTO MC_ZAP_CONFIG c USING (SELECT 'fora_horario_ativo' CHAVE FROM DUAL) n
  ON (c.CHAVE = n.CHAVE)
  WHEN NOT MATCHED THEN INSERT (CHAVE, VALOR) VALUES ('fora_horario_ativo', 'N');

MERGE INTO MC_ZAP_CONFIG c USING (SELECT 'horario_atendimento' CHAVE FROM DUAL) n
  ON (c.CHAVE = n.CHAVE)
  WHEN NOT MATCHED THEN INSERT (CHAVE, VALOR) VALUES ('horario_atendimento',
    '{"dom":null,"seg":{"inicio":"08:00","fim":"18:00"},"ter":{"inicio":"08:00","fim":"18:00"},"qua":{"inicio":"08:00","fim":"18:00"},"qui":{"inicio":"08:00","fim":"18:00"},"sex":{"inicio":"08:00","fim":"18:00"},"sab":{"inicio":"08:00","fim":"12:00"}}');

MERGE INTO MC_ZAP_CONFIG c USING (SELECT 'fora_horario_msg' CHAVE FROM DUAL) n
  ON (c.CHAVE = n.CHAVE)
  WHEN NOT MATCHED THEN INSERT (CHAVE, VALOR) VALUES ('fora_horario_msg',
    'Ola! No momento estamos fora do horario de atendimento. Retornaremos no proximo dia/horario util. Nosso horario: seg a sex 08h-18h, sab 08h-12h. Sua mensagem ja esta registrada e sera respondida.');

COMMIT;

-- 3) Verificação.
SELECT COLUMN_NAME FROM USER_TAB_COLUMNS
 WHERE TABLE_NAME = 'MC_ZAP_CONVERSA' AND COLUMN_NAME = 'AVISO_FORA_HORARIO';
SELECT CHAVE FROM MC_ZAP_CONFIG WHERE CHAVE IN ('fora_horario_ativo','horario_atendimento','fora_horario_msg');
