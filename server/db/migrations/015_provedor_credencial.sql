-- ============================================================================
-- 015_provedor_credencial.sql — FIL-78: credencial GLOBAL do operador (fim da
-- chave por tenant).
--
-- Decisão de produto: a conta do provedor de IA passa a ser do OPERADOR — uma
-- só POR PROVEDOR — em vez de uma chave cadastrada por cliente. O cliente
-- compra "IA" como add-on do plano e nunca vê custo, tokens, modelo ou chave.
-- Mesma lógica de conta compartilhada já usada na integração com a Meta.
--
-- ⚠️ TABELA FECHADA PARA O CAMINHO DE TENANT — MESMO PADRÃO de `operador` /
-- `operador_auditoria` (005_operador.sql): RLS ENABLE+FORCE com policy
-- USING(false) e REVOKE ALL de falatta_app. Uma rota de tenant (comTenant(),
-- role falatta_app) que tentasse ler esta tabela recebe "permission denied",
-- não uma linha vazia silenciosa. Só o caminho de operador
-- (operador/db.js::comOperador, BYPASSRLS) atravessa — ver
-- operador/credencialIa.js. A chave em si nunca é decifrada fora de
-- ia/iaConfigStore.js (runtime) e operador/credencialIa.js.
--
-- Compat: `ia_config` (por tenant, 001_inicial.sql) continua existindo e tem
-- PRIORIDADE quando o tenant já tem chave própria (ver ia/iaConfigStore.js) —
-- migração de dados é manual, tenant por tenant, feita pelo operador;
-- operador/tenants.js::listarComUso passou a marcar quem ainda usa chave
-- própria (`ia_chave_propria`) para o operador migrar aos poucos.
--
-- Teto por tenant (obrigatório pelo ticket): `tenant.ia_teto_tokens_mes`
-- (NULL = sem teto) + `ia_consumo_mensal` (tenant_id, ano_mes) guardam o
-- limite e o consumo já registrado. Só o SCHEMA e a checagem de bloqueio
-- (ia/limitePlano.js) nascem aqui — o INCREMENTO real por chamada é o FIL-77
-- (medição de consumo), o próximo ticket da fila: ele passa a gravar em
-- ia_consumo_mensal a cada chamada ao provedor.
--
-- IDEMPOTENTE: pode rodar mais de uma vez. Nunca edite este arquivo depois de
-- aplicado em um ambiente compartilhado — mudança de schema é migração nova.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- provedor_credencial — a credencial do OPERADOR, uma linha por provedor.
-- `ativo='S'` marca qual é A credencial em uso agora (índice único parcial
-- garante só uma ativa por vez — ver ux_predcred_ativo_unico); trocar de
-- provedor não apaga o histórico, só desativa a linha anterior, então voltar
-- atrás é só reativar (operador/credencialIa.js::salvarCredencial).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provedor_credencial (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider              varchar(30)  NOT NULL,
  modelo_padrao         varchar(100) NOT NULL,
  base_url              varchar(500),
  api_key_criptografada varchar(2000) NOT NULL,
  ativo                 char(1) NOT NULL DEFAULT 'S',
  atualizado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_predcred_provider UNIQUE (provider),
  CONSTRAINT ck_predcred_prov     CHECK (provider IN ('anthropic','openai','openrouter','ollama','vllm','groq')),
  CONSTRAINT ck_predcred_ativo    CHECK (ativo IN ('S','N'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_predcred_ativo_unico
  ON provedor_credencial (ativo) WHERE ativo = 'S';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provedor_credencial'] LOOP
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
REVOKE ALL ON provedor_credencial FROM falatta_app;
REVOKE ALL ON SEQUENCE provedor_credencial_id_seq FROM falatta_app;

-- ----------------------------------------------------------------------------
-- Teto por tenant — plano/add-on, NÃO credencial. Continua isolado por
-- tenant_id (tabela normal, RLS isolamento_tenant) porque é config de produto
-- do cliente, não segredo do operador.
-- ----------------------------------------------------------------------------
ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS ia_teto_tokens_mes bigint
    CHECK (ia_teto_tokens_mes IS NULL OR ia_teto_tokens_mes >= 0);

CREATE TABLE IF NOT EXISTS ia_consumo_mensal (
  tenant_id     bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  ano_mes       varchar(7) NOT NULL, -- 'YYYY-MM'
  tokens_usados bigint NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_iaconsumo    PRIMARY KEY (tenant_id, ano_mes),
  CONSTRAINT ck_iaconsumo_tk CHECK (tokens_usados >= 0)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ia_consumo_mensal'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS isolamento_tenant ON %I', t);
    EXECUTE format(
      'CREATE POLICY isolamento_tenant ON %I '
      || 'USING (tenant_id = tenant_atual()) '
      || 'WITH CHECK (tenant_id = tenant_atual())', t);
  END LOOP;
END
$$;
