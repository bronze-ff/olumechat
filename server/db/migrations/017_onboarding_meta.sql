-- FIL-81: checklist rastreável do onboarding assistido da Meta, por tenant.
-- Idempotente: pode ser aplicada novamente em ambientes já atualizados.
--
-- Uma linha por (tenant, etapa) das 7 etapas fixas do processo assistido
-- (código valida a lista — ver server/onboardingMeta/etapas.js). Etapa sem
-- linha aqui é tratada como 'pendente' pela API; a linha só nasce quando o
-- operador mexe pela primeira vez (UPSERT em server/api/onboardingMeta.js).
CREATE TABLE IF NOT EXISTS onboarding_meta_etapa (
  tenant_id      bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  etapa          varchar(30) NOT NULL,
  status         varchar(20) NOT NULL DEFAULT 'pendente',
  responsavel    varchar(160),
  observacao     varchar(500),
  data_referencia date,
  atualizado_por varchar(160),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_onb_etapa PRIMARY KEY (tenant_id, etapa),
  CONSTRAINT ck_onb_etapa CHECK (etapa IN (
    'conta_criada', 'verificacao_empresa', 'waba_criada', 'numero_verificado',
    'templates_submetidos', 'templates_aprovados', 'webhook_testado'
  )),
  CONSTRAINT ck_onb_status CHECK (status IN ('pendente', 'em_andamento', 'concluida', 'bloqueada'))
);

ALTER TABLE onboarding_meta_etapa ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_meta_etapa FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS isolamento_tenant ON onboarding_meta_etapa;
CREATE POLICY isolamento_tenant ON onboarding_meta_etapa
  USING (tenant_id = tenant_atual())
  WITH CHECK (tenant_id = tenant_atual());

GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_meta_etapa TO falatta_app;
