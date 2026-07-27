-- ============================================================================
-- 002_contato_generaliza.sql — Generaliza os campos de vínculo ERP do contato
-- (FIL-60): CODCLI/CGCENT eram nomes do ERP WinThor do fork original.
--
-- codcli  → codigo_externo  (identificador do cliente no sistema do tenant)
-- cgcent  → documento       (CPF/CNPJ do cliente no sistema do tenant)
--
-- Mesmo tipo/tamanho, só renomeia — ver docs/PORTE.md "Resíduo conhecido" e
-- server/utils/clienteLookup.js (seam que já usa este contrato genérico:
-- acharPorTelefone → { codigo, nome, documento }).
--
-- IDEMPOTENTE: os IF EXISTS guardam contra rodar mais de uma vez.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contato' AND column_name = 'codcli'
  ) THEN
    ALTER TABLE contato RENAME COLUMN codcli TO codigo_externo;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contato' AND column_name = 'cgcent'
  ) THEN
    ALTER TABLE contato RENAME COLUMN cgcent TO documento;
  END IF;
END
$$;

ALTER INDEX IF EXISTS ix_contato_codcli RENAME TO ix_contato_codigo_externo;
ALTER INDEX IF EXISTS ix_contato_cgcent RENAME TO ix_contato_documento;
