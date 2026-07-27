-- ============================================================================
-- MC-ZAP — HOTFIX do bot de IA: liberar FILA_STATUS='ia' no CHECK da conversa.
-- Rodar como MCLABS (dono das tabelas MC_ZAP_*).
--
-- Por que: o 16_ia.sql adicionou a coluna MODO e as tabelas da IA, mas NÃO
-- atualizou o CHECK CK_MCZAP_CONV_FILA (criado no 03_fase5b.sql com apenas
-- 'bot','aguardando','em_atendimento','resolvida'). Sem 'ia', o webhook falha
-- ao criar a conversa da IA com:
--   ORA-02290: restrição de verificação (MCLABS.CK_MCZAP_CONV_FILA) violada
-- e o bot NUNCA responde.
--
-- Idempotente: pode rodar mais de uma vez sem erro.
-- ============================================================================
BEGIN
  BEGIN
    EXECUTE IMMEDIATE 'ALTER TABLE MC_ZAP_CONVERSA DROP CONSTRAINT CK_MCZAP_CONV_FILA';
  EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -2443 THEN RAISE; END IF;  -- ORA-02443 = constraint não existe (ok)
  END;
  EXECUTE IMMEDIATE
    'ALTER TABLE MC_ZAP_CONVERSA ADD CONSTRAINT CK_MCZAP_CONV_FILA ' ||
    'CHECK (FILA_STATUS IN (''bot'',''aguardando'',''em_atendimento'',''resolvida'',''ia''))';
END;
/

-- Verificação: deve listar a constraint habilitada.
SELECT CONSTRAINT_NAME, STATUS
  FROM USER_CONSTRAINTS
 WHERE CONSTRAINT_NAME = 'CK_MCZAP_CONV_FILA';
