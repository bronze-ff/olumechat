# AGENTS.md — regras para agentes do Olume Chat

Fonte única. `CLAUDE.md` contém só `@AGENTS.md`. Edite este arquivo. Skills globais ficam em `~/.agents/skills/`; nada de skill é versionado aqui.

## Comandos

Na raiz, antes de abrir PR:

```powershell
npm run verify
```

Isso é obrigatório. Equivale a `npm test` no `server/` e a `npm test` mais `npm run build` no `client/`.

| Comando | Onde | O que faz |
|---|---|---|
| `npm test` | `server/` | Suíte (sem rede). Teste de RLS com Postgres real só roda com `TEST_DATABASE_URL`. |
| `npm run migrar` | `server/` | Aplica `db/migrations/` em ordem. |
| `npm run dev` | `server/` ou `client/` | API na 3001, Vite na 5173. |
| `npm run build` | `client/` | Bundle de produção. |

A `main` é protegida e exige estes checks verdes: `server-test`, `server-test-rls`, `client-build`, `npm-audit (server)`, `npm-audit (client)`, `backend-image` e `frontend-image`. O job `segredos` (gitleaks no diff) também precisa passar.

## Estrutura e onde mexer

| Onde | Mexa quando |
|---|---|
| `client/` | Tela, rota, estado do navegador. |
| `server/api/` | Regra do painel da empresa. |
| `server/webhook/` | Entrada da Meta. |
| `server/ia/`, `server/bot/`, `server/fila/` | Agente, fluxo e distribuição. |
| `server/operador/` | Painel interno. |
| `server/db/migrations/` | Schema. Só arquivo novo. |
| `docs/` | Comportamento visível, operação, decisão. |

Mapas locais: `server/AGENTS.md` e `client/AGENTS.md`. São deltas. O Codex sobe a partir da pasta aberta e não desce: para trabalhar no server, abra de dentro de `server/`.

Issues ficam no GitHub Issues deste repositório. Não abra ticket no Linear. Uma issue, uma branch, um PR. No PR, `Fixes #n`. Branch `<tipo>/<descricao>` cortada de `origin/main` fresca. Commit convencional em português. Não commite direto na `main`.

## Não faça

- Commitar `.env`, `.env.*` (exceto `.env.example`) ou `.mcp.json`.
- Colocar DSN, chave do PostHog ou token no repositório. Sem a variável, o SDK fica desligado.
- Renomear `client/` ou `server/`, ou mudar o deploy do Coolify, de staging ou de produção, sem um pedido explícito. O Dockerfile e os workflows de imagem dependem desses caminhos.
- Editar migração já aplicada. Mudança de schema é arquivo novo, expand/contract, idempotente.
- Segurar duas conexões do pool na mesma requisição. Leia o cabeçalho de `server/ia/runtime.js`.
- Misturar os dois JWTs (`JWT_SECRET` / `token` e `OPERADOR_JWT_SECRET` / `token_operador`).
- Usar a tabela `config` para dado sensível ou grande.
- Enfraquecer `BASE_SISTEMA` em `server/ia/perfilStore.js`.
- Renomear o role `falatta_app` ou os identificadores internos `falatta_*`. São legado do banco e quebram a instalação existente.
- Logar ou enviar a telemetria mensagem de chat, telefone, e-mail, CPF/CNPJ, senha, token, header, cookie ou corpo de request.
- Fazer merge. Quem mergeia é o humano, com review do Codex limpa e CI verde.
- Promover produção ou aprovar o environment `production`.

## Code Review Rules

O Codex Review (`codex review --base main`) roda em todo PR. Só se mergeia com review limpa e CI verde.

**P0 — barrar**

- Segredo, DSN ou chave no diff.
- Tabela nova fora do RLS `isolamento_tenant`, ou sem `UNIQUE (tenant_id, id)`.
- Tenant vindo de query, header ou body.
- Webhook respondendo 200 antes de gravar o evento.
- As duas sessões JWT misturadas.
- Corpo, header, cookie, query ou mensagem de WhatsApp indo para Sentry ou PostHog.
- `identify` do PostHog com e-mail, nome ou telefone.
- Migração que apaga coluna na mesma release em que o código para de usá-la.
- Camada 1 do prompt da IA editável pelo admin, ou enfraquecida.

**P1 — barrar se não houver decisão escrita**

- `VITE_*` nova sem build-arg no `client/Dockerfile` e sem nota em `docs/operacao.md`.
- Tracing do Sentry com taxa maior que 0 sem `beforeSendSpan` limpando a URL.
- Edição de workflow de deploy (`deploy-staging.yml`, `deploy-producao.yml`) ou de caminho do Coolify.
- Query de tenant fora de `comTenant()`, ou caminho de operador fora de `comOperador()`.
- Texto de UI em outro idioma, ou com jargão de implementação. O vocabulário está em `docs/produto/PRODUCT.md`.

## Observabilidade

DSN e chave só por ambiente: `SENTRY_DSN` na API, `VITE_SENTRY_DSN` e `VITE_POSTHOG_KEY` no build do frontend. Sem variável, não há cliente. Projetos: Sentry `olumechat-web` e `olumechat-api`; PostHog na EU.

O scrub é allowlist (`server/observabilidade/scrub.js` e `client/src/observabilidade/scrub.js`): sem headers, cookies, body ou query; URL só com origem e caminho; palavra sensível redige a string inteira e não altera campo de transporte do SDK. Tracing fica em taxa 0, com `beforeSendSpan` limpando a URL. PostHog só com usuário logado, `person_profiles: 'identified_only'`, `identify` só com `u:<id>` ou `o:<id>`, máscara total.

Variáveis públicas do Vite são lidas de forma estática (`import.meta.env.VITE_SENTRY_DSN`). Lista e onde configurar: `docs/operacao.md`.

## Regras de ouro

1. Produção está no ar. A mudança passa por staging. Produção é promoção manual da mesma imagem.
2. `docs/WORKFLOW.md` e `docs/AMBIENTES.md` são o contrato de branch, PR e deploy. Na dúvida de ambiente, vale `docs/AMBIENTES.md`.
3. Texto de produto em português. Visual em `docs/produto/DESIGN.md`.
4. O webhook resolve a empresa pelo `phone_number_id`. A Meta não manda tenant.
5. Evento de tempo real só depois do commit.

## Índice

- `docs/funcionalidades.md`, `docs/arquitetura.md`, `docs/operacao.md`, `docs/decisoes/`
- `docs/WORKFLOW.md`, `docs/AMBIENTES.md`, `docs/SEGURANCA.md`
- `docs/GO-LIVE-PENDENCIAS.md`, `docs/CARGA-2026-08.md`
- Legado, não siga como deploy atual: `docs/DEPLOY.md`, `docs/ESCALABILIDADE.md`. `docs/DEPLOY_VPS.md` é o plano anterior ao que está no ar; o runbook vigente é `docs/AMBIENTES.md`.
