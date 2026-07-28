-- 012_clientes_preferencia.sql — transforma o contato em uma ficha de cliente
-- útil para CRM leve e adiciona o atendente de referência para roteamento.
-- Idempotente: este arquivo pode ser reaplicado com segurança.

ALTER TABLE contato ADD COLUMN IF NOT EXISTS nome_completo varchar(200);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS razao_social varchar(200);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS nome_fantasia varchar(200);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS email varchar(254);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS telefone_alternativo varchar(20);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS cep varchar(9);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS logradouro varchar(200);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS numero_endereco varchar(30);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS complemento varchar(100);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS bairro varchar(100);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS cidade varchar(100);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS uf char(2);
ALTER TABLE contato ADD COLUMN IF NOT EXISTS atendente_preferencial_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_contato_atd_preferencial'
  ) THEN
    ALTER TABLE contato
      ADD CONSTRAINT fk_contato_atd_preferencial
      FOREIGN KEY (tenant_id, atendente_preferencial_id)
      REFERENCES atendente (tenant_id, id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_contato_atd_preferencial
  ON contato (tenant_id, atendente_preferencial_id);

CREATE INDEX IF NOT EXISTS ix_contato_nome_busca
  ON contato (tenant_id, nome_interno, nome_completo, nome_perfil);
