# 0001 — Padronização da onda 1, sem renomear pastas

**Data:** 2026-10-12. **Status:** aceita.

## Contexto

A onda 1 pede README curto, `AGENTS.md` como fonte única, `docs/` no formato comum, CI em camadas e observabilidade com scrub. O plano de pastas também sugere `client/` → `web/` e `server/` → `api/`. Neste repositório isso é risco alto: `Dockerfile`, `client/Dockerfile`, os workflows de imagem e o Coolify usam esses caminhos. Staging e produção estão no ar.

O tracker operacional era o Linear (time FIL). A decisão da onda é GitHub Issues neste repositório.

## Decisão

- As pastas de código permanecem `client/` e `server/`. Deploy, Coolify e os workflows `deploy-staging.yml`, `deploy-producao.yml` e `monitoramento-externo.yml` não mudam de comportamento.
- `PRODUCT.md` e `DESIGN.md` saem da raiz e vão para `docs/produto/`.
- Issues novas são GitHub Issues (`Fixes #n`). Identificadores FIL antigos em specs e comentários são histórico do Linear, não o tracker atual.
- A CI ganha gitleaks só no range de commits novos, actions pinadas por SHA e uma camada `ci-full` (label `ci:full`, push na `main`, semanal). Os jobs que a proteção da `main` e a publicação no GHCR já exigem continuam com o mesmo nome.
- Sentry usa `@sentry/react` e `@sentry/node`. PostHog só no navegador e só com sessão. DSN e chave só por variável de ambiente. Scrub por allowlist desde o primeiro evento.

## Consequências

- Renomear pastas fica para uma janela própria, com staging primeiro. Não faz parte desta mudança.
- Produção não envia telemetria até as variáveis da `docs/operacao.md` existirem no Coolify e nas variables do GitHub. Sem elas o SDK não inicia e o build não falha.
- O projeto PostHog deve ser criado na região EU. O host padrão do código é `https://eu.i.posthog.com`.
- Projetos Sentry esperados: `olumechat-web` e `olumechat-api`.
