-- FIL-74: blacklist de JWT compartilhada entre instâncias.
-- Idempotente; nunca editar migrações já aplicadas.
-- tenant_id é nulo apenas para tokens do painel de operador, que usam o
-- caminho explícito comOperador(). Tokens de tenant são protegidos por RLS.
CREATE TABLE IF NOT EXISTS token_blacklist (
  jti        varchar(255) PRIMARY KEY,
  tenant_id  bigint REFERENCES tenant (id),
  expira_em  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_token_blacklist_expira_em
  ON token_blacklist (expira_em);

ALTER TABLE token_blacklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_blacklist FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_tenant ON token_blacklist;
CREATE POLICY isolamento_tenant ON token_blacklist
  USING (tenant_id = tenant_atual())
  WITH CHECK (tenant_id = tenant_atual());

GRANT SELECT, INSERT, UPDATE, DELETE ON token_blacklist TO falatta_app;
