-- ============================================================================
-- 004_usuarios.sql — Login próprio do Falatta (FIL-67).
--
-- Substitui a autenticação contra a tabela de senhas do ERP do cliente
-- original (texto plano, comparação com UPPER()) por uma tabela de usuários
-- POR TENANT, com senha em hash argon2id.
--
-- COMO APLICAR (Neon — use a connection string DIRETA para DDL, se tiver):
--   psql "$DATABASE_URL" -f server/db/migrations/004_usuarios.sql
--
-- Ordem: depois de 001_inicial.sql (depende de tenant_atual(), da tabela
-- `tenant` e do role `falatta_app`). Não depende de 002/003.
--
-- IDEMPOTENTE: pode rodar mais de uma vez (IF NOT EXISTS / DROP POLICY IF
-- EXISTS + CREATE). Nunca edite este arquivo depois de aplicado em um
-- ambiente compartilhado — mudança de schema é migração NOVA e numerada.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- usuario — identidade de LOGIN do tenant. Uma linha por pessoa que entra no
-- painel. O operador cadastra (FIL-70) e o próprio usuário define a senha no
-- primeiro acesso, por link com token (tabela abaixo).
--
-- ⚠️ RELAÇÃO COM `atendente`: `atendente` continua sendo a identidade
-- OPERACIONAL (papel RBAC, departamentos, fila, autoria de mensagem) e é
-- chaveada por `matricula` — resíduo do fork que o resto do sistema inteiro
-- usa (req.user.matricula em api/, fila/, realtime/). O login próprio NÃO
-- inventa uma matrícula nova: usa `usuario.id` como matrícula. É estável,
-- único dentro do tenant e dispensa o operador escolher um número no
-- cadastro. O `atendente` correspondente nasce no primeiro login
-- (auth/rbac.js::carregarPerfil, que já cria lazy). Renomear `matricula` para
-- `usuario_id` no resto do sistema é outro ticket.
--
-- `email` é gravado SEMPRE em minúsculas (CHECK abaixo): o login compara
-- e-mail sem diferenciar caixa, mas a SENHA é comparada byte a byte — nunca
-- normalize a senha.
--
-- `senha_hash` nasce NULL: o usuário recém-cadastrado ainda não tem senha e
-- NÃO consegue logar (o login exige hash presente). Só passa a ter senha
-- quando consome um token de definição.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuario (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id          bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  email              varchar(160) NOT NULL,
  senha_hash         varchar(255),
  senha_definida_em  timestamptz,
  nome               varchar(120),
  ativo              char(1) NOT NULL DEFAULT 'S',
  criado_em          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_usuario_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_usuario_email     UNIQUE (tenant_id, email),
  CONSTRAINT ck_usuario_ativo     CHECK (ativo IN ('S','N')),
  -- Normalização explícita: um INSERT com "Fulano@Empresa.com" é ERRO, não uma
  -- segunda conta invisível ao lado de "fulano@empresa.com".
  CONSTRAINT ck_usuario_email_min CHECK (email = lower(email)),
  CONSTRAINT ck_usuario_email_fmt CHECK (email LIKE '%_@_%._%')
);

-- ----------------------------------------------------------------------------
-- usuario_token_senha — token de definição/redefinição de senha: USO ÚNICO e
-- com EXPIRAÇÃO.
--
-- ⚠️ O token em claro NUNCA é gravado. Guardamos o SHA-256 dele: quem
-- conseguir ler a tabela (dump, backup, SQL injection) não consegue montar o
-- link. SHA-256 — e não argon2 — é o hash certo AQUI porque o token tem 256
-- bits de entropia de CSPRNG: não há dicionário para atacar, e a verificação
-- precisa ser barata. Argon2 é para SENHA humana, que tem entropia baixa.
--
-- `usado_em` NOT NULL depois do consumo; o UPDATE de consumo filtra
-- `usado_em IS NULL` e confere rowsAffected — é isso que torna o uso único
-- atômico mesmo com duas requisições simultâneas.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuario_token_senha (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  usuario_id bigint NOT NULL,
  token_hash varchar(64) NOT NULL,
  expira_em  timestamptz NOT NULL,
  usado_em   timestamptz,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_uts_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_uts_hash      UNIQUE (tenant_id, token_hash),
  CONSTRAINT fk_uts_usuario   FOREIGN KEY (tenant_id, usuario_id)
    REFERENCES usuario (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS ix_uts_usuario ON usuario_token_senha (tenant_id, usuario_id, usado_em);

-- ============================================================================
-- ROW-LEVEL SECURITY — mesmo padrão da 001: ENABLE + FORCE + policy
-- `isolamento_tenant`. Sem contexto de tenant, zero linhas.
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuario','usuario_token_senha'] LOOP
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

-- A 001 deixou ALTER DEFAULT PRIVILEGES para o role de aplicação, então estas
-- tabelas já nascem acessíveis SE a 004 rodar com o mesmo usuário da 001.
-- O GRANT explícito abaixo cobre o caso de rodarem com usuários diferentes.
GRANT SELECT, INSERT, UPDATE, DELETE ON usuario, usuario_token_senha TO falatta_app;
GRANT USAGE, SELECT ON SEQUENCE usuario_id_seq, usuario_token_senha_id_seq TO falatta_app;
