# AGENTS.md — guia de agentes do Olume Chat

> **Fonte de verdade única.** `CLAUDE.md` contém apenas `@AGENTS.md` (import nativo do
> Claude Code) — edite SEMPRE este arquivo; o Claude importa e os demais agentes (Codex,
> Gemini, etc.) leem `AGENTS.md` nativamente. Skills: vivem em `.claude/skills/`; em cada
> **checkout** (inclusive worktree — toda worktree do Orca nasce sem a junction, mesmo as
> criadas em onda), crie a junction `.agents/skills` → `.claude/skills` (fica fora do git):
> `New-Item -ItemType Junction -Path .agents\skills -Target .claude\skills`, ou rode
> `powershell -File scripts/setup-worktree.ps1` (idempotente — cria só se faltar). Dá pra
> automatizar por worktree criada pelo Orca: `orca repo show --json` expõe
> `hookSettings.scripts.setup` (hoje roda `npm ci` e copia `.env.local`) — é config local de
> cada instalação do Orca, não vai pro git, então some a chamada do script ali (Orca →
> Settings do repo → Setup script) se quiser zero passo manual na sua máquina; o script e a
> junction manual continuam sendo a rede de segurança para quem não configurou o hook.

## O que é

Plataforma **multi-tenant** de atendimento por WhatsApp direto na **Cloud API da Meta**
(sem BSP): inbox multi-atendente com filas e tempo real (SSE), chatbot de fluxos, agente de
IA (responde, escuta áudio, vê imagem, age e transfere para humano), campanhas, métricas e
um **painel do operador** (provisionamento, financeiro, sessão de suporte auditada).

## Estado atual (2026-07-30)

- **EM PRODUÇÃO.** `olumechat.com.br` (landing + app) e `api.olumechat.com.br` no ar,
  em VPS com Coolify. Staging espelhado em `staging.olumechat.com.br` (atrás de
  Cloudflare Access). Ver **`docs/AMBIENTES.md`** antes de mexer em qualquer coisa que
  chegue ao deploy.
- Falta só a conta Meta para o WhatsApp funcionar (`META_APP_SECRET` está com
  placeholder — o webhook rejeita tudo até ser trocado, que é o comportamento seguro).
- Roadmap de IA completo (FIL-83..86): instruções/base de conhecimento por empresa,
  atendimento com handoff nos dois sentidos, STT (whisper) + visão, ferramentas nativas
  (ficha, tag, pedido com template por empresa) e upload de PDF/XLSX/CSV na base.
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
   CI verde (`server-test`, `server-test-rls`, `client-build`).
2. **Produção está no ar.** Migração é **expand/contract** (nunca remove coluna na mesma
   release que para de usá-la), variável nova precisa entrar no Coolify dos ambientes que
   a usam, e `VITE_*` exige rebuild. Mudança vai para staging antes de produção.
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

## Integrações que os agentes usam aqui

- **Orca CLI** (`orca ...`) — worktrees, terminais, automações; **`orca linear ...`** — tickets FIL-*
- **gh** — PRs (sempre contra `main`); **Codex** — review cruzada (`codex review --base main`)
- **Neon** (Postgres do produto) · **Meta Cloud API** (WhatsApp) · **R2/S3** (mídia em produção)

## Índice de docs

- `docs/WORKFLOW.md` — branch/commit/teste/PR/deploy (contrato)
- `docs/AMBIENTES.md` — dev, staging e produção: endereços, acesso, promoção e armadilhas
- `docs/GO-LIVE-PENDENCIAS.md` — o que falta para o primeiro cliente
- `docs/DEPLOY.md` — produção: Vercel (front) + Render (server) + Neon + R2
- `docs/SEGURANCA.md` · `docs/ESCALABILIDADE.md` · `docs/PORTE.md` (histórico do porte)
- `PRODUCT.md` (produto/marca) · `DESIGN.md` (visual)
- `docs/superpowers/specs/` — specs aprovadas por feature (IA: 4 fatias + handoff + upload)
- `docs/estudos/` — estudos (ex.: Meta Business Agent Platform)
