-- 011_ia_operador.sql — IA vira add-on vendido à parte: só o OPERADOR decide
-- se um tenant tem acesso (é o plano), o admin do cliente não liga sozinho.
-- `ia_habilitada` é o gate; provider/modelo/chave (ia_config) passam a ser
-- escritos pelo operador (operador/tenants.js), não mais pelo admin do tenant
-- (api/iaConfig.js perde o PUT — só lê status).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS com o CHECK inline — se a coluna já
-- existir (rerun), a cláusula inteira é pulada e o CHECK já anexado persiste.
ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS ia_habilitada char(1) NOT NULL DEFAULT 'N'
    CHECK (ia_habilitada IN ('S', 'N'));
