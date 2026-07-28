-- ============================================================================
-- 016_consumo.sql — FIL-77: medição de consumo por cliente (IA, mensagens,
-- armazenamento), para o operador cobrar com margem.
--
-- Decisão de produto (mesma linha do FIL-78): o operador é dono da conta do
-- provedor de IA e do relacionamento com a Meta. O cliente NUNCA vê custo,
-- tokens ou preço unitário — só o operador, em /api/operador/*.
--
-- TRÊS TABELAS:
--
--   preco_provedor  — tabela de preço por provedor/modelo, mantida pelo
--     OPERADOR (server/consumo/precos.js), NUNCA hardcoded no runtime. O
--     provedor devolve os tokens consumidos; o preço em reais é nosso.
--     MESMO PADRÃO FECHADO de `provedor_credencial` (015): RLS deny-all para
--     o caminho de tenant — só comOperador() (BYPASSRLS) lê/escreve.
--
--   consumo_evento  — append-only, uma linha por evento cobrável. Cresce
--     rápido: retenção de 90 dias no bruto (server/consumo/fechamento.js
--     limpa só o que já foi agregado em consumo_mensal — nunca perde dado
--     não fechado). RLS normal de tenant (isolamento_tenant): é gravada pelo
--     caminho de tenant (ia/runtime.js, api/conversas.js dentro de
--     db.comTenant()) a cada chamada de IA e a cada envio.
--
--   consumo_mensal  — agregado fechado por competência, para sempre (é o que
--     alimenta o faturamento do FIL-79). Alimentado por
--     server/consumo/fechamento.js::fecharMes(), idempotente (UPSERT por
--     tenant_id+ano_mes+tipo — rodar duas vezes não duplica nem soma em
--     dobro).
--
-- ⚠️ CONEXÃO COM O FIL-78: `ia_consumo_mensal` (015) é o TETO por tenant que
-- ia/limitePlano.js já checa — o próprio comentário da 015 deixou isto como
-- ponto de extensão do FIL-77. server/consumo/registrar.js incrementa
-- ia_consumo_mensal.tokens_usados a cada evento `ia_tokens`, além de gravar
-- em consumo_evento. `ia_consumo_mensal` (só tokens, só para o teto) e
-- `consumo_mensal` (todos os tipos, com custo, para faturamento) são tabelas
-- DIFERENTES de propósitos diferentes — nenhuma substitui a outra.
--
-- IDEMPOTENTE: pode rodar mais de uma vez. Nunca edite este arquivo depois de
-- aplicado em um ambiente compartilhado — mudança de schema é migração nova.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- preco_provedor — preço por 1000 tokens de entrada/saída, em CENTAVOS de
-- real, por provider+modelo. Editável via PUT /api/operador/precos. Fechada
-- para o caminho de tenant (mesmo racional de provedor_credencial: nunca é
-- lida por uma conexão com role falatta_app).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preco_provedor (
  provider                  varchar(30)   NOT NULL,
  modelo                    varchar(100)  NOT NULL,
  preco_entrada_centavos_1k numeric(12,6) NOT NULL DEFAULT 0 CHECK (preco_entrada_centavos_1k >= 0),
  preco_saida_centavos_1k   numeric(12,6) NOT NULL DEFAULT 0 CHECK (preco_saida_centavos_1k >= 0),
  atualizado_em             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT pk_precoprov      PRIMARY KEY (provider, modelo),
  CONSTRAINT ck_precoprov_prov CHECK (provider IN ('anthropic','openai','openrouter','ollama','vllm','groq'))
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['preco_provedor'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS sem_acesso_por_tenant ON %I', t);
    EXECUTE format(
      'CREATE POLICY sem_acesso_por_tenant ON %I USING (false) WITH CHECK (false)', t);
  END LOOP;
END
$$;

REVOKE ALL ON preco_provedor FROM falatta_app;

-- ----------------------------------------------------------------------------
-- consumo_evento — bruto, append-only. Um evento por chamada de IA (tokens),
-- por mensagem/mídia enviada. `referencia` guarda o id da conversa OU da
-- mensagem, conforme o tipo (sem FK — os dois domínios são possíveis).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consumo_evento (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  tipo           varchar(30) NOT NULL,
  quantidade     bigint NOT NULL CHECK (quantidade >= 0),
  -- NULL = custo desconhecido no momento do evento (ex.: preço do modelo
  -- ainda não cadastrado pelo operador) — nunca inventado.
  custo_centavos numeric(14,6),
  referencia     bigint,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_consevt_tipo CHECK (tipo IN ('ia_tokens','mensagem_enviada','conversa_iniciada','midia_armazenada'))
);

CREATE INDEX IF NOT EXISTS ix_consevt_tenant_tipo_criado ON consumo_evento (tenant_id, tipo, criado_em);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consumo_evento'] LOOP
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

-- ----------------------------------------------------------------------------
-- consumo_mensal — agregado fechado por competência, para sempre (retenção
-- do bruto é só 90 dias — ver cabeçalho). fechado_em marca quando a última
-- (re)agregação idempotente rodou.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consumo_mensal (
  tenant_id      bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  ano_mes        varchar(7) NOT NULL, -- 'YYYY-MM'
  tipo           varchar(30) NOT NULL,
  quantidade     bigint NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
  custo_centavos numeric(14,6) NOT NULL DEFAULT 0,
  fechado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_consmensal      PRIMARY KEY (tenant_id, ano_mes, tipo),
  CONSTRAINT ck_consmensal_tipo CHECK (tipo IN ('ia_tokens','mensagem_enviada','conversa_iniciada','midia_armazenada'))
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consumo_mensal'] LOOP
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
