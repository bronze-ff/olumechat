-- ============================================================================
-- 005_operador.sql — Painel do OPERADOR do Falatta (FIL-70).
--
-- O operador somos NÓS (super-admin do SaaS). Ele está FORA da hierarquia de
-- tenant: não é um `atendente` com papel ADMIN, não tem `tenant_id` e não
-- entra pelo login de tenant (`usuario` / auth/routes.js). É quem provisiona,
-- suspende, reativa e renomeia tenants.
--
-- COMO APLICAR (Neon — use a connection string DIRETA para DDL, se tiver):
--   psql "$DATABASE_URL" -f server/db/migrations/005_operador.sql
--   (ou `cd server && npm run migrar`, que aplica todas em ordem)
--
-- Ordem: depois de 001_inicial.sql (depende da tabela `tenant` e do role
-- `falatta_app`) e de 004_usuarios.sql (o provisionamento grava em `usuario` e
-- `usuario_token_senha`, mas o SCHEMA daqui não depende delas).
--
-- IDEMPOTENTE: pode rodar mais de uma vez (IF NOT EXISTS / DROP POLICY IF
-- EXISTS + CREATE). Nunca edite este arquivo depois de aplicado em um
-- ambiente compartilhado — mudança de schema é migração NOVA e numerada.
--
-- ⚠️ ESTAS DUAS TABELAS NÃO SÃO TABELAS DE TENANT — E É DE PROPÓSITO ⚠️
--
-- Todo o resto do schema segue a regra "tenant_id NOT NULL + policy
-- `isolamento_tenant`". Aqui não dá: uma credencial de operador não pertence a
-- tenant nenhum, e a trilha de auditoria dele precisa atravessar tenants (é o
-- registro de QUEM mexeu em QUAL cliente). Em vez de fingir que são tabelas de
-- tenant, elas são explicitamente FECHADAS para o caminho de tenant:
--
--   • RLS ENABLE + FORCE com policy `sem_acesso_por_tenant` USING (false):
--     nenhuma linha é visível nem gravável por quem passa pelas policies;
--   • REVOKE ALL ... FROM falatta_app: o role que `comTenant()` assume não tem
--     sequer privilégio de tabela. Uma query de tenant que tentasse ler
--     `operador` recebe "permission denied", não uma lista vazia silenciosa.
--     (A 001 deixou ALTER DEFAULT PRIVILEGES concedendo tudo em tabelas novas
--     para `falatta_app` — este REVOKE é o que desfaz isso AQUI.)
--
-- Quem lê/escreve estas tabelas é o caminho de operador (server/operador/db.js
-- ::comOperador), que roda com o usuário do DATABASE_URL, sem `SET LOCAL ROLE
-- falatta_app` e com o contexto de tenant explicitamente NULO. É o mesmo
-- "system path" já documentado no dispatcher de campanha (leitura crua que
-- cruza tenants de propósito) — nunca uma query comum que só funciona porque
-- alguém esqueceu de setar o tenant.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- operador — credencial do super-admin. Sem `tenant_id` por definição.
--
-- `email` é único GLOBALMENTE (não por tenant, como em `usuario`) e gravado
-- sempre em minúsculas. `senha_hash` é argon2id (server/auth/senha.js, o mesmo
-- módulo do login de tenant — o algoritmo de senha é um só no sistema).
--
-- Não há auto-cadastro: o primeiro operador nasce pelo script
-- `npm run criar-operador` (server/scripts/criar-operador.js), rodado por
-- quem tem acesso ao banco. Um endpoint público de "criar operador" seria a
-- porta dos fundos do sistema inteiro.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operador (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          varchar(160) NOT NULL,
  senha_hash     varchar(255) NOT NULL,
  nome           varchar(120),
  ativo          char(1) NOT NULL DEFAULT 'S',
  ultimo_acesso_em timestamptz,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_operador_email     UNIQUE (email),
  CONSTRAINT ck_operador_ativo     CHECK (ativo IN ('S','N')),
  CONSTRAINT ck_operador_email_min CHECK (email = lower(email)),
  CONSTRAINT ck_operador_email_fmt CHECK (email LIKE '%_@_%._%')
);

-- ----------------------------------------------------------------------------
-- operador_auditoria — trilha de TODA ação de operador: quem, quando, em qual
-- tenant, o quê.
--
-- `tenant_id` aqui NÃO é chave de isolamento: é O ALVO da ação, e é NULO nas
-- ações que não têm tenant (login, logout, listagem geral). Sem FK, pelo mesmo
-- motivo da tabela `auditoria` da 001: a trilha não pode falhar por
-- integridade referencial nem sumir se a linha alvo sumir.
--
-- `operador_email` é uma FOTO do e-mail no momento da ação. Guardar só o
-- `operador_id` deixaria a trilha ilegível se a conta fosse renomeada depois.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operador_auditoria (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operador_id    bigint,
  operador_email varchar(160),
  tenant_id      bigint,
  acao           varchar(60) NOT NULL,
  entidade       varchar(40),
  entidade_id    bigint,
  detalhe        jsonb,
  ip             varchar(45),
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_opaud_tenant ON operador_auditoria (tenant_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_opaud_oper   ON operador_auditoria (operador_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_opaud_dt     ON operador_auditoria (criado_em DESC);

-- ============================================================================
-- FECHAMENTO PARA O CAMINHO DE TENANT (ver ⚠️ no cabeçalho).
-- RLS habilitada em todas as tabelas é invariante do repo (scripts/migrar.js
-- reclama se alguma ficar de fora) — aqui ela é habilitada para NEGAR.
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operador','operador_auditoria'] LOOP
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
REVOKE ALL ON operador, operador_auditoria FROM falatta_app;
REVOKE ALL ON SEQUENCE operador_id_seq, operador_auditoria_id_seq FROM falatta_app;
