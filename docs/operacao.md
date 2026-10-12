# Operação

Como isto sobe, onde está cada variável e como voltar atrás. O passo a passo de staging, promoção e rollback está em [`AMBIENTES.md`](AMBIENTES.md). Este arquivo é o mapa; aquele é o runbook.

## Ambientes

| | Dev | Staging | Produção |
|---|---|---|---|
| Front | `localhost:5173` | `staging.olumechat.com.br` | `olumechat.com.br` |
| API | `localhost:3001` | `api-staging.olumechat.com.br` | `api.olumechat.com.br` |
| Onde roda | a máquina | VPS, Coolify, ambiente `staging` | VPS, Coolify, ambiente `production` |
| Banco | branch Neon de desenvolvimento | branch `staging` | branch `production` |
| Imagem | build local | GHCR `sha-<commit>` | a mesma imagem validada em staging |

Merge na `main` publica a imagem e sobe staging. Produção só muda com o workflow *Deploy produção*, aprovado à mão. Não há deploy automático para produção.

A versão servida aparece em `/health/live` (API) e `/version.json` (frontend). O smoke falha se o SHA não for o do commit.

## Variáveis novas desta padronização

Nenhum valor entra no repositório. Sem a variável, o SDK não inicia.

| Variável | Onde | Projeto |
|---|---|---|
| `SENTRY_DSN` | Coolify, runtime da API (staging e produção) | Sentry `olumechat-api` |
| `SENTRY_ENVIRONMENT` | Coolify, runtime da API. `homologacao` ou `producao` | o mesmo |
| `VITE_SENTRY_DSN` | GitHub Actions variable **e** build-arg da imagem do frontend. Exige rebuild | Sentry `olumechat-web` |
| `VITE_SENTRY_ENVIRONMENT` | A CI já grava `homologacao` na imagem de staging e `producao` na de produção | o mesmo |
| `VITE_POSTHOG_KEY` | GitHub Actions variable e build-arg do frontend | PostHog EU, projeto do Olume Chat |
| `VITE_POSTHOG_HOST` | Opcional. Vazio usa `https://eu.i.posthog.com` | o mesmo |
| `SENTRY_AUTH_TOKEN` | GitHub Actions **secret**. Só o build do frontend. Sem ele o build segue e não publica source map | org do Sentry |
| `SENTRY_ORG` | GitHub Actions variable | org do Sentry |
| `SENTRY_PROJECT_WEB` | GitHub Actions variable. Valor esperado: `olumechat-web` | projeto web |

`VITE_*` é lida no `docker build` do client (`client/Dockerfile`). Colocar a variável só no runtime do Nginx não altera o bundle já gerado.

No painel do Sentry, de cada projeto: Data Scrubber ligado, Scrub IP addresses ligado, e regras extras para CPF, CNPJ, telefone, e-mail e placa. Erro não é arquivo de dado pessoal.

## O que a telemetria aceita

- Sentry: `sendDefaultPii` desligado, corpo/header/cookie/query fora, URL só com origem e caminho, tracing em taxa 0 com `beforeSendSpan` limpando a URL, usuário só com id interno (`u:<id>` ou `o:<id>`).
- PostHog: só com alguém logado. `person_profiles: identified_only`. `identify` só com esse id. Máscara de texto, de atributo e de input. Gravação de sessão desligada, e evento de snapshot é descartado. Landing anônima não inicia o SDK.
- Mensagem de chat, transcrição e corpo de webhook não são campo de evento.

## Logs e rollback

Log da API sai no stdout do container (Coolify). O ticket do SSE é redatado na linha de acesso. Rollback de código é o mesmo workflow de promoção, com um SHA anterior. Rollback não desfaz migração: por isso a mudança de schema é expand/contract.

Segredos de runtime (`JWT_SECRET`, `OPERADOR_JWT_SECRET`, `IA_CRYPTO_KEY`, `META_APP_SECRET`, `DATABASE_URL`) continuam só no Coolify de cada ambiente, ou no `server/.env` local, que não é commitado.
