-- 013_cliente_responsavel_departamento.sql
-- O responsável de um cliente pertence a um departamento específico.
-- Um vínculo em Vendas, por exemplo, não altera o roteamento em Financeiro.

CREATE TABLE IF NOT EXISTS contato_atendente_depto (
  tenant_id       bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  contato_id      bigint NOT NULL,
  departamento_id bigint NOT NULL,
  atendente_id    bigint NOT NULL,
  criado_por      bigint,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_contato_atd_depto PRIMARY KEY (tenant_id, contato_id, departamento_id),
  CONSTRAINT fk_cad_contato FOREIGN KEY (tenant_id, contato_id)
    REFERENCES contato (tenant_id, id),
  CONSTRAINT fk_cad_depto FOREIGN KEY (tenant_id, departamento_id)
    REFERENCES departamento (tenant_id, id),
  CONSTRAINT fk_cad_atendente FOREIGN KEY (tenant_id, atendente_id)
    REFERENCES atendente (tenant_id, id),
  CONSTRAINT fk_cad_criador FOREIGN KEY (tenant_id, criado_por)
    REFERENCES atendente (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS ix_cad_atendente
  ON contato_atendente_depto (tenant_id, atendente_id);
CREATE INDEX IF NOT EXISTS ix_cad_departamento
  ON contato_atendente_depto (tenant_id, departamento_id);

ALTER TABLE contato_atendente_depto ENABLE ROW LEVEL SECURITY;
ALTER TABLE contato_atendente_depto FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_tenant ON contato_atendente_depto;
CREATE POLICY isolamento_tenant ON contato_atendente_depto
  USING (tenant_id = tenant_atual())
  WITH CHECK (tenant_id = tenant_atual());

GRANT SELECT, INSERT, UPDATE, DELETE ON contato_atendente_depto TO falatta_app;

-- Compatibilidade: converte o vínculo global da migração anterior em vínculos
-- nos departamentos dos quais o atendente participa. O campo antigo permanece
-- apenas para permitir rollback de aplicação; o produto deixa de consultá-lo.
INSERT INTO contato_atendente_depto
  (tenant_id, contato_id, departamento_id, atendente_id, atualizado_em)
SELECT ct.tenant_id, ct.id, ad.departamento_id, ct.atendente_preferencial_id, now()
  FROM contato ct
  JOIN atendente_depto ad
    ON ad.tenant_id = ct.tenant_id
   AND ad.atendente_id = ct.atendente_preferencial_id
 WHERE ct.atendente_preferencial_id IS NOT NULL
ON CONFLICT (tenant_id, contato_id, departamento_id) DO NOTHING;
