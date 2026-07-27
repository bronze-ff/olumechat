-- FIL-71: credenciais Meta e estado do Embedded Signup, por tenant.
-- Idempotente: pode ser aplicada novamente em ambientes já atualizados.
CREATE TABLE IF NOT EXISTS meta_conexao (
  tenant_id bigint PRIMARY KEY REFERENCES tenant (id),
  waba_id varchar(40),
  access_token_criptografado varchar(4000) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'conectando',
  ultimo_erro varchar(500),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_meta_conexao_status CHECK (status IN ('conectando','conectada','pendente','erro','desconectada'))
);

ALTER TABLE meta_conexao ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_conexao FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_tenant ON meta_conexao;
CREATE POLICY isolamento_tenant ON meta_conexao
  USING (tenant_id = tenant_atual())
  WITH CHECK (tenant_id = tenant_atual());

GRANT SELECT, INSERT, UPDATE, DELETE ON meta_conexao TO falatta_app;
