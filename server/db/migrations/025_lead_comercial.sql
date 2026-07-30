-- ============================================================================
-- 025_lead_comercial.sql — FIL-96: o formulário da landing passa a GRAVAR o
-- lead, em vez de só montar um `mailto:` que morre se o visitante não tiver
-- cliente de e-mail configurado (o caso mais comum num navegador com Gmail).
--
-- ⚠️ ESTE LEAD É DA OLUME, NÃO DE UM TENANT — MESMO PADRÃO de `operador` /
-- `operador_auditoria` (005_operador.sql) e `provedor_credencial`
-- (015_provedor_credencial.sql): RLS ENABLE+FORCE com policy USING(false) e
-- REVOKE ALL de falatta_app. Uma rota de tenant (comTenant(), role
-- falatta_app) que tentasse ler esta tabela recebe "permission denied", não
-- uma lista vazia silenciosa. Só o caminho de operador
-- (operador/db.js::comOperador, BYPASSRLS) atravessa — inclusive o INSERT
-- público do POST /api/leads, que roda por dentro de comOperador() sem
-- sessão de operador (ver server/api/leads.js e server/operador/leads.js).
--
-- IDEMPOTENTE: pode rodar mais de uma vez (IF NOT EXISTS / DROP POLICY IF
-- EXISTS + CREATE). Nunca edite este arquivo depois de aplicado em um
-- ambiente compartilhado — mudança de schema é migração NOVA e numerada.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_comercial (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome           varchar(160) NOT NULL,
  empresa        varchar(160) NOT NULL,
  email          varchar(160) NOT NULL,
  tamanho_equipe varchar(60),
  -- Querystring utm (utm_source=...&utm_campaign=...) quando o visitante
  -- chegou por uma campanha rastreada; NULL em acesso direto.
  origem         varchar(200),
  user_agent     varchar(300),
  ip             varchar(45),
  status         varchar(12) NOT NULL DEFAULT 'novo',
  observacao     text,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_leadcom_status    CHECK (status IN ('novo', 'contatado', 'descartado')),
  CONSTRAINT ck_leadcom_email_fmt CHECK (email LIKE '%_@_%._%')
);

-- Painel do operador: filtro por status e o "novos primeiro" da listagem.
CREATE INDEX IF NOT EXISTS ix_leadcom_status_criado ON lead_comercial (status, criado_em DESC);
-- Badge de contagem no menu — índice PARCIAL porque 'novo' é o único estado
-- consultado com frequência (os outros dois só aparecem na listagem filtrada).
CREATE INDEX IF NOT EXISTS ix_leadcom_novo ON lead_comercial (criado_em) WHERE status = 'novo';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_comercial'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS sem_acesso_por_tenant ON %I', t);
    -- USING (false): quem passa pelas policies (falatta_app) não enxerga nem
    -- grava nada. Só o dono da conexão (BYPASSRLS), usado pelo caminho de
    -- operador, atravessa — e ele ainda precisa do privilégio de tabela.
    EXECUTE format(
      'CREATE POLICY sem_acesso_por_tenant ON %I USING (false) WITH CHECK (false)', t);
  END LOOP;
END
$$;

-- Desfaz o GRANT automático das ALTER DEFAULT PRIVILEGES da 001.
REVOKE ALL ON lead_comercial FROM falatta_app;
REVOKE ALL ON SEQUENCE lead_comercial_id_seq FROM falatta_app;
