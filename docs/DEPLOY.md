# Deploy — front na Vercel + backend no Render

O server é um processo persistente (SSE com LISTEN/NOTIFY, dispatcher de campanha, distribuidor
de fila, IA fire-and-forget pós-webhook) e por isso **não roda em serverless da Vercel**. O
desenho de produção é:

```
app.olumechat.com.br  → Vercel (client/ estático, Vite)
                       └─ rewrite /api/* → Render (mesma origem, sem CORS)
api → Render (server/, Node persistente)  ← webhook da Meta aponta DIRETO aqui
Neon (Postgres)  ·  Cloudflare R2 (mídia, driver s3)
```

## 1. Neon (banco)

Já existente. Separe as três connection strings no painel do Neon:
- **pooled** (host com `-pooler`) → `DATABASE_URL`
- **direta** (sem `-pooler`) → `DATABASE_URL_DIRECT` (LISTEN/NOTIFY do SSE) e
  `MIGRATION_DATABASE_URL` (migrações no pre-deploy)

## 2. Cloudflare R2 (mídia)

O disco do Render é efêmero — mídia de WhatsApp precisa do driver s3.

1. R2 → Create bucket (ex.: `olumechat-media`).
2. R2 → Manage API Tokens → token com Object Read & Write no bucket.
3. Anote: endpoint `https://<account-id>.r2.cloudflarestorage.com`, access key e secret.

## 3. Render (backend)

1. New → Web Service → conectar o repo `bronze-ff/olumechat`.
2. **Root Directory:** `server` · **Build:** `npm ci` · **Start:** `npm start`.
3. **Pre-Deploy Command:** `npm run migrar` (usa `MIGRATION_DATABASE_URL`; roda a cada deploy —
   as migrações são idempotentes por contrato).
4. **Health Check Path:** `/health`.
5. Cadastrar as variáveis de ambiente (tabela abaixo) e fazer o deploy.
6. Primeiro acesso do painel do operador: Shell do serviço → `npm run criar-operador`.
7. Anotar a URL pública (ex.: `https://olumechat.onrender.com`).

### Variáveis de ambiente do backend (Render)

Obrigatórias:

| Variável | Valor / como obter |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon **pooled** (host `-pooler`), com `?sslmode=require` |
| `DATABASE_URL_DIRECT` | Neon **direta** (sem `-pooler`) — sem ela o SSE fica desabilitado |
| `MIGRATION_DATABASE_URL` | Neon direta — usada pelo `npm run migrar` no pre-deploy |
| `META_APP_SECRET` | Meta for Developers → App → Configurações → Básico |
| `META_APP_ID` | idem |
| `WEBHOOK_VERIFY_TOKEN` | string aleatória sua (`openssl rand -hex 16`) — a mesma vai no painel da Meta |
| `GRAPH_VERSION` | `v21.0` (ou a atual) |
| `JWT_SECRET` | `openssl rand -hex 48` |
| `OPERADOR_JWT_SECRET` | `openssl rand -hex 48` — **diferente** do `JWT_SECRET` |
| `IA_CRYPTO_KEY` | `openssl rand -hex 32` — dedicada e ESTÁVEL (cifra as API keys de IA; sem ela cai no JWT_SECRET, que não pode mais rotacionar) |
| `APP_URL` | URL pública do front na Vercel (ex.: `https://app.olumechat.com.br`) — monta links de convite |
| `STORAGE_DRIVER` | `s3` |
| `STORAGE_BUCKET` | nome do bucket R2 |
| `STORAGE_REGION` | `auto` |
| `STORAGE_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `AWS_ACCESS_KEY_ID` | access key do token R2 (o SDK lê do ambiente) |
| `AWS_SECRET_ACCESS_KEY` | secret do token R2 |
| `STORAGE_SIGNING_SECRET` | `openssl rand -hex 32` (assina URLs de mídia) |

Opcionais (defaults sensatos no código):

| Variável | Default | Para quê |
|---|---|---|
| `JWT_EXPIRES_IN` / `OPERADOR_JWT_EXPIRES_IN` | `8h` / `2h` | validade das sessões |
| `OPERADOR_SUPORTE_TTL_MIN` | `30` | sessão de suporte no tenant |
| `SENHA_TOKEN_TTL_MIN` | `4320` | validade do link de senha |
| `DB_POOL_MAX` | `10` | teto do pool por instância |
| `GRAPH_TIMEOUT_MS` | — | timeout das chamadas à Meta |
| `WEBHOOK_VERIFY_RATE_LIMIT_MAX`, `ENVIO_RATE_LIMIT_MAX`, `IA_TESTAR_RATE_LIMIT_MAX`, `IA_EXTRAIR_RATE_LIMIT_MAX`, `SUGESTAO_IA_RATE_LIMIT_MAX` | — | rate limits |
| `CAMPANHA_CSV_MAX_LINHAS`, `IA_EXTRACAO_MAX_LINHAS`, `IA_EXTRACAO_XLSX_MAX_DESCOMPRIMIDO` | — | limites de import/extração |
| `CONSUMO_RETENCAO_DIAS`, `FATURA_DIAS_ATRASO` | — | financeiro |
| `PULSO_URL/KEY/SECRET/ANON_KEY/...` | desligado | telemetria/licença |
| `GITHUB_OWNER/REPO/REF/TOKEN` | mc-OS | atualização de conhecimento legado |

Não usar em produção: `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`,
`DEV_META_FALLBACK` (fallback de dev; produção resolve credencial por tenant),
`MEDIA_DIR`/`CONHECIMENTO_DIR` (só driver local).

## 4. Vercel (front)

1. New Project → importar o repo `bronze-ff/olumechat`.
2. **Root Directory:** `client` · Framework preset: **Vite** (build `npm run build`, output `dist`).
3. Editar `client/vercel.json`: trocar `https://SEU-BACKEND.onrender.com` pela URL real do
   Render (o rewrite mantém `/api` na mesma origem — sem CORS, e o SSE passa junto).
4. Variáveis de ambiente:

| Variável | Valor |
|---|---|
| `VITE_COMERCIAL_EMAIL` | e-mail do formulário público de demonstração |
| `VITE_API_URL` | **deixar vazia** (usa `/api` via rewrite). Só preencher com a URL do backend se abandonar o rewrite — aí o server precisa de CORS, que hoje não tem |

5. Deploy e testar login.

> Se o SSE (tempo real) engasgar atravessando o proxy da Vercel (raro, mas acontece com
> streaming), o plano B é apontar `VITE_API_URL` direto pro Render e adicionar CORS no
> Express — me chame que eu faço.

## 5. Meta (webhook)

No app da Meta → WhatsApp → Configuration:
- **Callback URL:** `https://<render>.onrender.com/webhook` (direto no Render, NÃO passa pela Vercel)
- **Verify token:** o mesmo `WEBHOOK_VERIFY_TOKEN`
- Assinar o campo `messages`.

## 6. Domínios (opcional)

- `app.olumechat.com.br` → Vercel (Settings → Domains; atualizar `APP_URL` no Render).
- `api.olumechat.com.br` → Render (Custom Domain; atualizar o destino no `client/vercel.json` e o
  callback na Meta).

## Ordem de subida

Neon (já tem) → R2 → Render (backend + migrações + criar-operador) → Vercel (front com a URL
do Render no vercel.json) → Meta (webhook) → smoke test: login, conversa de teste, SSE ao vivo,
upload de mídia.
