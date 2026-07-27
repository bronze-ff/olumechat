-- ============================================================================
-- limpar_mc_zap.sql — DROPA todas as tabelas MC_ZAP_* do schema CONECTADO.
-- ============================================================================
-- Use para reverter uma execucao PARCIAL do instalar_em_nova_empresa.sql e
-- recriar do zero. SO rode num schema SEM dados de produção (apaga tudo).
--
-- Bloco PL/SQL unico: roda em qualquer ferramenta (PL/SQL Developer SQL Window
-- com F8, Command Window, SQL Developer F5, SQL*Plus). Ignora FKs (CASCADE
-- CONSTRAINTS) e a ordem das tabelas.
-- ============================================================================
BEGIN
  FOR t IN (
    SELECT table_name FROM user_tables
     WHERE table_name LIKE 'MC\_ZAP\_%' ESCAPE '\'
  ) LOOP
    EXECUTE IMMEDIATE 'DROP TABLE "' || t.table_name || '" CASCADE CONSTRAINTS PURGE';
    DBMS_OUTPUT.PUT_LINE('Removida: ' || t.table_name);
  END LOOP;
END;
/
