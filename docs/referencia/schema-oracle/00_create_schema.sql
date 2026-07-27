-- =====================================================================
-- MC-Zap — Criação do schema/usuário dedicado  (rodar como DBA / SYS)
-- Schema: MCLABS  (dono das tabelas MC_ZAP_*)
--
-- Isola o sistema de atendimento do schema MCCANAL. O backend conecta
-- como MCLABS; o DDL (01_mc_zap.sql) cria os objetos SEM prefixo, ou
-- seja, dentro do schema de quem conecta (MCLABS).
-- =====================================================================

-- 1) Cria o usuário/schema. TROQUE a senha abaixo.
CREATE USER MCLABS IDENTIFIED BY "TROQUE_ESTA_SENHA";

-- 2) Privilégios mínimos para a aplicação criar e usar seus objetos.
GRANT CONNECT, RESOURCE TO MCLABS;
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE TO MCLABS;

-- 3) Quota no tablespace. Ajuste 'USERS' para o tablespace padrão do banco
--    (confirme com o DBA: SELECT property_value FROM database_properties
--     WHERE property_name = 'DEFAULT_PERMANENT_TABLESPACE';).
ALTER USER MCLABS QUOTA UNLIMITED ON USERS;

-- 4) (FASES FUTURAS — opcional) Quando o sistema precisar ler dados do
--    WinThor (PCCLIENT/PCPREST) e o login (MC_SENHAS), conceda SELECT e
--    crie sinônimos. NÃO é necessário para a Fase 0. Exemplo:
--    GRANT SELECT ON MCCANAL.PCCLIENT TO MCLABS;
--    GRANT SELECT ON MCCANAL.PCPREST  TO MCLABS;
--    GRANT SELECT ON MCCANAL.MC_SENHAS TO MCLABS;
--    CREATE OR REPLACE SYNONYM MCLABS.PCCLIENT  FOR MCCANAL.PCCLIENT;
--    CREATE OR REPLACE SYNONYM MCLABS.PCPREST   FOR MCCANAL.PCPREST;
--    CREATE OR REPLACE SYNONYM MCLABS.MC_SENHAS FOR MCCANAL.MC_SENHAS;
