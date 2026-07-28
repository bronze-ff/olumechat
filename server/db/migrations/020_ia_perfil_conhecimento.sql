-- ============================================================================
-- 020_ia_perfil_conhecimento.sql — FIL-83: instruções e base de conhecimento
-- da IA, POR EMPRESA.
--
-- Até aqui o system prompt vinha de um arquivo em disco
-- (CONHECIMENTO_DIR/system-prompt.md), global para o processo inteiro — e como
-- a pasta não existe no repositório, TODA empresa rodava com o fallback
-- embutido ("assistente da Multicanal Atacado"). Estas duas tabelas passam a
-- ser a fonte do prompt, por tenant (ver server/ia/perfilStore.js).
--
-- DUAS TABELAS:
--
--   ia_perfil       — 1 linha por empresa: instruções livres do admin + ficha
--     (jsonb) com os dados fixos do negócio. jsonb em vez de colunas fixas
--     porque a ficha vai crescer (área de entrega, redes sociais) e
--     scripts/migrar.js re-executa TODO o histórico a cada deploy — cada campo
--     novo viraria mais uma migração no caminho crítico do boot. Quem valida
--     as chaves é a aplicação (server/ia/perfilStore.js::CAMPOS_FICHA).
--
--   ia_conhecimento — N blocos por empresa ("Cardápio", "Política de troca"),
--     ligáveis/desligáveis (`ativo`) em vez de apagáveis: cardápio sazonal e
--     promoção encerrada voltam. `ordem` define a posição no prompt.
--
-- ⚠️ AS DUAS ENTRAM NO BLOCO DE RLS `isolamento_tenant` (mesmo padrão das
-- migrações 013/016/017). Tabela nova fora dele fica sem isolamento entre
-- empresas, silenciosamente — e o conteúdo aqui É o que a IA fala com o
-- cliente final.
--
-- IDEMPOTENTE DE VERDADE: só CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS +
-- CREATE POLICY e GRANT. Nenhum INSERT/backfill (ninguém em produção ainda).
-- Nunca edite este arquivo depois de aplicado — mudança de schema é migração
-- nova.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ia_perfil — uma linha por empresa.
-- `atualizado_por` usa a FK COMPOSTA (tenant_id, id) de atendente, convenção do
-- schema. NULL é permitido de propósito: a sessão de suporte do operador não é
-- funcionário do cliente e não tem atendente_id (ver auth/rbac.js::
-- PERFIL_SUPORTE) — MATCH SIMPLE não checa a FK quando alguma coluna é NULL.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ia_perfil (
  tenant_id      bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  instrucoes     text,
  ficha          jsonb NOT NULL DEFAULT '{}'::jsonb,
  atualizado_por bigint,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_ia_perfil PRIMARY KEY (tenant_id),
  CONSTRAINT fk_ia_perfil_atendente FOREIGN KEY (tenant_id, atualizado_por)
    REFERENCES atendente (tenant_id, id)
);

-- ----------------------------------------------------------------------------
-- ia_conhecimento — blocos de conteúdo. UNIQUE (tenant_id, id) é a convenção do
-- schema (permite FK composta depois, como já fazem contato/atendente).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ia_conhecimento (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id     bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  titulo        varchar(120) NOT NULL,
  conteudo      text NOT NULL,
  ativo         char(1) NOT NULL DEFAULT 'S',
  ordem         integer NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_ia_conhecimento     PRIMARY KEY (id),
  CONSTRAINT uq_ia_conhecimento     UNIQUE (tenant_id, id),
  CONSTRAINT ck_ia_conhecimento_ativo CHECK (ativo IN ('S', 'N'))
);

-- Leitura quente do runtime: blocos ATIVOS de um tenant, na ordem do prompt.
CREATE INDEX IF NOT EXISTS ix_ia_conhecimento_ativo
  ON ia_conhecimento (tenant_id, ativo, ordem);

-- ----------------------------------------------------------------------------
-- RLS — mesmo bloco `isolamento_tenant` das demais tabelas de tenant.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ia_perfil', 'ia_conhecimento'] LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE ON ia_perfil       TO falatta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ia_conhecimento TO falatta_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public   TO falatta_app;
