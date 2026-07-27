-- Object storage guarda a chave (não um caminho local). Índice idempotente para
-- localizar mídias pelo tenant sem permitir consultas cross-tenant.
CREATE INDEX IF NOT EXISTS ix_msg_midia_chave
  ON mensagem (tenant_id, midia_caminho)
  WHERE midia_caminho IS NOT NULL;
