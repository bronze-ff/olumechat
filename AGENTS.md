# AGENTS.md — guia de agentes do Olume Chat

> **Fonte de verdade única.** `CLAUDE.md` contém apenas `@AGENTS.md` (import nativo do
> Claude Code) — edite SEMPRE este arquivo; o Claude importa e os demais agentes (Codex,
> Gemini, etc.) leem `AGENTS.md` nativamente. Skills reutilizáveis vivem **globalmente** em
> `~/.agents/skills/` (o Claude aponta `~/.claude/skills/<skill>` para a mesma pasta por
> junction) — nada de skill é versionado aqui, e nenhum passo por checkout é necessário. A
> skill global `orquestrar-projeto` (`/orquestrar-projeto` no Claude, `$orquestrar-projeto`
> no Codex) coordena o trabalho e lê as políticas deste repo: este arquivo,
> `docs/WORKFLOW.md` e `docs/AMBIENTES.md`.

## O que é

Plataforma **multi-tenant** de atendimento por WhatsApp direto na **Cloud API da Meta**
(sem BSP): inbox multi-atendente com filas e tempo real (SSE), chatbot de fluxos, agente de
IA (responde, escuta áudio, vê imagem, age e transfere para humano), campanhas, métricas e
um **painel do operador** (provisionamento, financeiro, sessão de suporte auditada).

## Estado atual (2026-08-01)

- **EM PRODUÇÃO.** `olumechat.com.br` (landing + app) e `api.olumechat.com.br` no ar,
  em VPS com Coolify. Staging espelhado em `staging.olumechat.com.br` (atrás de
  Cloudflare Access). Ver **`docs/AMBIENTES.md`** antes de mexer em qualquer coisa que
  chegue ao deploy.
- **Pipeline de deploy fechado e exercitado** (FIL-99→100→101 + FIL-113): a CI publica
  `sha-<commit>` no GHCR, staging sobe sozinho, e produção só recebe promoção manual
  aprovada (Actions → *Deploy produção*). Toda resposta carrega a build que a produziu
  (`/health/*` e `/version.json`) e o smoke **falha** se a versão servida divergir.
  Promoção e rollback foram exercitados de verdade em 2026-08-01.
- Falta só a conta Meta para o WhatsApp funcionar (`META_APP_SECRET` está com
  placeholder — o webhook rejeita tudo até ser trocado, que é o comportamento seguro).
- Roadmap de IA completo (FIL-83..86): instruções/base de conhecimento por empresa,
  atendimento com handoff nos dois sentidos, STT (whisper) + visão, ferramentas nativas
  (ficha, tag, pedido com template por empresa) e upload de PDF/XLSX/CSV na base.
- **Riscos aceitos e conscientes** (não são esquecimento): Neon no plano Free, com PITR
  de **6 horas** — janela curta demais depois que houver dado de cliente (FIL-110);
  carga medida em laboratório (`docs/CARGA-2026-08.md`), **nunca na VPS** — o limite de
  produção segue desconhecido, e o que quebra primeiro é o pool, não o hub SSE.
- Suite do server: `cd server && npm test` (1.000+ testes; integração com Postgres real só
  com `TEST_DATABASE_URL` — na CI o job `server-test-rls` a fornece e teste pulado vira
  falha). Client: `cd client && npm run build`.

## Stack e estrutura

| Onde | O quê |
|---|---|
| `server/` | Express + `pg` (Neon). Entrada `app.js`. Processo **persistente** (SSE via LISTEN/NOTIFY, dispatcher de campanha, distribuidor de fila, IA fire-and-forget) — não roda em serverless |
| `server/db/migrations/` | Migrações numeradas, re-executadas TODAS a cada deploy (`npm run migrar`) |
| `server/api/` `server/ia/` `server/bot/` `server/fila/` `server/webhook/` `server/operador/` | Módulos de negócio |
| `client/` | React 18 + Vite + Tailwind. SPA; em dev o Vite proxeia `/api` → `:3001` |
| `docs/` | Contratos e specs (índice abaixo) |

## Rodar local

```bash
cd server && npm run migrar && node app.js     # precisa de server/.env (DATABASE_URL etc.)
cd client && npm run dev                        # http://localhost:5173
```

## Regras de ouro (custam caro quando ignoradas)

1. **`docs/WORKFLOW.md` é contrato**: branch `<tipo>/<descricao>` cortada de `origin/main`
   fresca, Conventional Commits em português, suite verde antes do PR, nunca commitar
   código direto na `main`, um ticket = uma branch = um PR. A `main` é protegida e exige
   **7 checks verdes**: `server-test`, `server-test-rls`, `client-build`,
   `npm-audit (server)`, `npm-audit (client)`, `backend-image` e `frontend-image`.
2. **Produção está no ar.** Migração é **expand/contract** (nunca remove coluna na mesma
   release que para de usá-la), variável nova precisa entrar no Coolify dos ambientes que
   a usam, e `VITE_*` exige rebuild. Mudança vai para staging antes de produção — e
   produção só recebe promoção manual aprovada, nunca deploy automático.
3. **Tabela nova entra no bloco RLS `isolamento_tenant`** (padrão das migrações 013/016/
   020/021/022) e ganha `UNIQUE (tenant_id, id)`. Fora do bloco = sem isolamento entre
   empresas, silenciosamente.
4. **Migração idempotente de verdade** — o histórico inteiro roda a cada deploy; "não dá
   erro ao repetir" não basta (backfills precisam de guarda).
5. **Nunca segure duas conexões do pool na mesma requisição.** O runtime da IA é dividido
   em 3 fases exatamente por isso (`server/ia/runtime.js`); `iaConfigStore.carregar()` NÃO
   recebe `conn`, `perfilStore.carregar(conn, ...)` recebe. Leia os cabeçalhos antes de mexer.
6. **Dois JWTs distintos de propósito**: sessão do cliente (`JWT_SECRET`, `token`) e do
   operador (`OPERADOR_JWT_SECRET`, `token_operador`) nunca se misturam — axios separados
   (`services/api.js` vs `services/apiOperador.js`). `IA_CRYPTO_KEY` é dedicada e estável.
7. **Não use a tabela `config` para dado sensível ou grande**: o GET devolve tudo a
   qualquer autenticado e o PUT trunca em 2.000 chars.
8. **Multi-tenant no webhook**: a Meta não manda tenant — resolve-se por `phone_number_id`
   (única unicidade global do schema). Um único webhook para todos os clientes.
9. **Texto de produto em PT-BR**, sem vocabulário da Multicanal (anti-referência do
   `PRODUCT.md`), e sem expor jargão de implementação na UI.
10. Camada 1 do prompt da IA (`BASE_SISTEMA` em `ia/perfilStore.js`) é **intocável por
   admin**: anti-alucinação, guarda de escopo, anti-injeção e sigilo — não enfraqueça.
11. Identificadores internos `falatta_*` (role do banco, migrações) são legado pré-rebrand
    (FIL-91: empresa Olume / produto Olume Chat) e **não devem ser renomeados** — troca de
    role é mudança de infra sem valor de marca e quebraria o banco existente.

## Mapas por nível (padrão do repo)

Cada pasta de trabalho diário tem o próprio par `AGENTS.md` (conteúdo) + `CLAUDE.md`
(`@AGENTS.md`): **`server/AGENTS.md`** (módulos e regras do backend) e
**`client/AGENTS.md`** (front). São **deltas** — não repetem o raiz. Atenção com o Codex:
ele varre da pasta de abertura para CIMA (nunca desce) — para trabalhar focado no server,
abra-o de dentro de `server/`.

## Política de orquestração (o que a skill global precisa saber daqui)

A skill global `orquestrar-projeto` é agnóstica de projeto e lê estas decisões aqui.
Não estão em lugar nenhum além deste bloco — se você orquestrar sem ler, vai improvisar:

| Decisão | Política deste repo |
|---|---|
| Papéis | **Claude implementa, Codex revisa** (`codex review --base main`, uma passada por PR), humano mergeia |
| Modelos dos workers | **Opus** para ticket de fundação/alto risco (deploy, segurança, schema); **Sonnet** para feature e correção padrão; **Haiku** só para mecânico. O modelo do orquestrador **nunca** é usado em worker |
| Como subir o worker | Criar a worktree **sem** `--agent` e subir o agente com `orca terminal create --command "claude --model <x>"`. Lançar com `--agent` herda o modelo default da sessão e o `/model` posterior não corrige a tempo |
| Tracker | Linear, time FIL, **projeto "Olume Chat"** (`51f26218-651e-483f-b6ed-32757605f2ac`) — passe `--project` ao criar ticket, senão ele nasce órfão |
| Dependência | Só o que está em `blockedBy`. Nunca inferida do título |
| Gate de onda | **Merge do humano.** O orquestrador nunca mergeia |
| Gate de produção | Promoção manual aprovada no GitHub Environment `production`. Agente **não promove** sem pedido explícito, e nunca aprova |
| Verificação | CI verde é obrigatório, não opcional; relato de worker não é prova — confira o PR e os checks |
| Custo | Upgrade de plano, compra e credencial nova são **sempre** do humano |

## Integrações que os agentes usam aqui

- **Orca CLI** (`orca ...`) — worktrees, terminais, automações; **`orca linear ...`** — tickets FIL-*
- **gh** — PRs (sempre contra `main`); **Codex** — review cruzada (`codex review --base main`)
- **Neon** (Postgres do produto) · **Meta Cloud API** (WhatsApp) · **R2/S3** (mídia em produção)

## Índice de docs

- `docs/WORKFLOW.md` — branch/commit/teste/PR/deploy (contrato)
- `docs/AMBIENTES.md` — **como produção funciona hoje**: endereços, acesso, promoção,
  rollback e armadilhas. É a fonte de verdade sobre deploy; na dúvida entre docs, vale este.
- `docs/GO-LIVE-PENDENCIAS.md` — o que falta para o primeiro cliente
- `docs/CARGA-2026-08.md` — teste de carga: limites medidos e onde quebra (harness em
  `scripts/carga/`). O gargalo é o pool do Postgres, não o hub SSE.
- `docs/SEGURANCA.md` — checklist que todo PR confirma · `docs/PORTE.md` (histórico do porte)
- ⚠️ **Legados, não siga**: `docs/DEPLOY.md` (Vercel + Render) e `docs/ESCALABILIDADE.md`
  (diagramas com Vercel/Render) descrevem a infraestrutura **anterior**. Servem só como
  histórico do desenho antigo. `docs/DEPLOY_VPS.md` é o plano da VPS — bom para custo,
  decisões e runbook, mas foi escrito **antes** do provisionamento e não foi convertido em
  registro do que realmente ficou (FIL-116).
- `PRODUCT.md` (produto/marca) · `DESIGN.md` (visual)
- `docs/superpowers/specs/` — specs aprovadas por feature (IA: 4 fatias + handoff + upload)
- `docs/estudos/` — estudos (ex.: Meta Business Agent Platform)
