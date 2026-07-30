-- ============================================================================
-- 026_meta_app_por_cliente.sql — FIL-97: um app da Meta POR CLIENTE, ao lado do
-- modelo de plataforma (app único da Olume).
--
-- POR QUE ISTO EXISTE: sem CNPJ não há verificação na Meta nem app próprio da
-- Olume — e sem app próprio nenhum cliente entra. Enquanto isso, cada cliente
-- usa o app DELE. Os dois modelos convivem: quando a Olume tiver app próprio,
-- clientes novos entram por Embedded Signup e os antigos migram um a um.
--
-- ── O PROBLEMA QUE A COLUNA `webhook_identificador` RESOLVE ────────────────
-- A validação `X-Hub-Signature-256` usa o App Secret. Com um app por cliente é
-- preciso saber DE QUEM é a mensagem ANTES de validar — e essa informação só
-- existe no corpo, que ainda não é confiável. Por isso cada cliente recebe uma
-- URL exclusiva de webhook (`/webhook/<identificador>`): o CAMINHO identifica o
-- tenant antes de qualquer parsing, o segredo dele é carregado e a assinatura é
-- validada. Sem heurística sobre corpo não validado.
--
-- ⚠️ O IDENTIFICADOR É OPACO (32 hex aleatórios), NÃO o slug do tenant. O
-- caminho vai colado numa configuração pública do app do cliente e aparece em
-- log de proxy/CDN — com o slug, quem visse uma URL saberia o nome do cliente e
-- poderia enumerar a carteira inteira trocando o sufixo. Opaco e não
-- adivinhável, o caminho não revela nem quem é o cliente nem que outros
-- existem. Ele NÃO é um segredo de autenticação (quem autentica é a assinatura
-- HMAC); é só um seletor que não vaza informação.
--
-- ── `webhook_evento.webhook_tenant_id` (ISOLAMENTO ENTRE EMPRESAS) ─────────
-- Com app por cliente, o App Secret deixa de ser único: o tenant A assina com o
-- segredo DELE. Uma assinatura válida no caminho de A prova "veio do app de A",
-- e NADA sobre o conteúdo — um payload forjado com o `phone_number_id` do
-- tenant B seria aceito pela assinatura de A e escrito na empresa B. Esta
-- coluna guarda o tenant DONO DO CAMINHO por onde o evento entrou; o
-- processamento (server/webhook/processEvent.js) descarta qualquer change cujo
-- número pertença a outro tenant. Fica no BANCO, e não só na requisição, porque
-- o reprocessamento da recuperação (FIL-94) roda muito depois do POST original
-- e precisa da mesma amarração.
-- NULL = evento do webhook GLOBAL (`/webhook`, META_APP_SECRET), onde o segredo
-- é da própria Olume e vale para todos — comportamento inalterado.
--
-- EXPAND/CONTRACT: só colunas NOVAS e NULLABLE, nada é removido nem reescrito.
-- Código antigo continua funcionando com as colunas ignoradas; rollback de
-- imagem não exige rollback de banco.
--
-- IDEMPOTENTE: pode rodar mais de uma vez (o deploy reaplica o histórico
-- inteiro). Nunca edite este arquivo depois de aplicado em um ambiente
-- compartilhado — mudança de schema é migração nova.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- meta_conexao (008) — ganha o app do cliente ao lado do access token.
-- A tabela JÁ está no bloco RLS `isolamento_tenant` da 008; coluna nova herda o
-- isolamento sem precisar repetir a policy.
-- ---------------------------------------------------------------------------
ALTER TABLE meta_conexao ADD COLUMN IF NOT EXISTS app_id varchar(40);

-- Cifrado com o MESMO caminho do access token (server/ia/crypto.js, AES-256-GCM
-- com chave derivada de IA_CRYPTO_KEY + tenant). Contexto próprio
-- ('meta_app_secret'), então o blob do segredo não é decifrável com a chave do
-- token e vice-versa.
ALTER TABLE meta_conexao ADD COLUMN IF NOT EXISTS app_secret_criptografado varchar(4000);

-- 32 hex (server/meta/appCliente.js::gerarIdentificador).
ALTER TABLE meta_conexao ADD COLUMN IF NOT EXISTS webhook_identificador varchar(64);

-- Unicidade GLOBAL (não por tenant), como `numero.phone_number_id`: o caminho
-- chega SEM contexto de tenant nenhum — é ele que resolve o tenant. Índice
-- PARCIAL porque a coluna é nullable e todo tenant que ainda não tem app
-- próprio fica com NULL (vários NULLs não colidem, mas o índice parcial deixa
-- explícito que a linha sem identificador não participa).
CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_conexao_webhook_ident
  ON meta_conexao (webhook_identificador)
  WHERE webhook_identificador IS NOT NULL;

-- ---------------------------------------------------------------------------
-- webhook_evento (023) — de qual caminho o evento entrou.
--
-- ⚠️ NÃO é `tenant_id` e NÃO transforma esta tabela numa tabela de tenant: ela
-- continua sendo de SISTEMA (policy USING(false) + REVOKE de falatta_app, ver
-- 023), gravada pelo caminho de sistema do webhook antes de qualquer tenant
-- estar resolvido. O nome é `webhook_tenant_id` de propósito, para ninguém ler
-- isto como "agora dá para filtrar por tenant aqui".
-- ---------------------------------------------------------------------------
ALTER TABLE webhook_evento
  ADD COLUMN IF NOT EXISTS webhook_tenant_id bigint REFERENCES tenant (id);
