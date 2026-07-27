-- 006_campanha_segmento.sql — importação de público sem SQL livre (FIL-68)
-- Idempotente; nunca alterar migrações já aplicadas.
CREATE TABLE IF NOT EXISTS campanha_import_linha (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  campanha_id bigint NOT NULL,
  numero_linha integer NOT NULL,
  telefone varchar(20),
  variaveis jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(30) NOT NULL,
  motivo varchar(60),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_cil_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_cil_linha UNIQUE (tenant_id, campanha_id, numero_linha),
  CONSTRAINT fk_cil_camp FOREIGN KEY (tenant_id, campanha_id) REFERENCES campanha (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT ck_cil_status CHECK (status IN ('aceita', 'rejeitada'))
);
CREATE INDEX IF NOT EXISTS ix_cil_camp ON campanha_import_linha (tenant_id, campanha_id, status);
ALTER TABLE campanha_import_linha ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanha_import_linha FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_tenant ON campanha_import_linha;
CREATE POLICY isolamento_tenant ON campanha_import_linha
  USING (tenant_id = tenant_atual()) WITH CHECK (tenant_id = tenant_atual());
GRANT SELECT, INSERT, UPDATE, DELETE ON campanha_import_linha TO falatta_app;
GRANT USAGE, SELECT ON SEQUENCE campanha_import_linha_id_seq TO falatta_app;
