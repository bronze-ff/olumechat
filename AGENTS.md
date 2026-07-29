# AGENTS.md — guia de agentes do Olume Chat

> **Fonte de verdade única.** `CLAUDE.md` contém apenas `@AGENTS.md` (import nativo do
> Claude Code) — edite SEMPRE este arquivo; o Claude importa e os demais agentes (Codex,
> Gemini, etc.) leem `AGENTS.md` nativamente. Skills: vivem em `.claude/skills/`; em cada
> máquina, crie a junction `.agents/skills` → `.claude/skills` (fica fora do git):
> `New-Item -ItemType Junction -Path .agents\skills -Target .claude\skills`

## O que é

Plataforma **multi-tenant** de atendimento por WhatsApp direto na **Cloud API da Meta**
(sem BSP): inbox multi-atendente com filas e tempo real (SSE), chatbot de fluxos, agente de
IA (responde, escuta áudio, vê imagem, age e transfere para humano), campanhas, métricas e
um **painel do operador** (provisionamento, financeiro, sessão de suporte auditada).

## Estado atual (2026-07-29)

- **Roda de ponta a ponta.** O porte Oracle→Postgres/Neon foi concluído; ignore avisos
  antigos de "fork em porte" que ainda existam em docs — na dúvida, o código manda.
- Roadmap de IA completo (FIL-83..86): instruções/base de conhecimento por empresa,
  atendimento com handoff nos dois sentidos, STT (whisper) + visão, ferramentas nativas
  (ficha, tag, pedido com template por empresa) e upload de PDF/XLSX/CSV na base.
- Suite do server: `cd server && npm test` (1.000+ testes; integração com Postgres real só
  com `TEST_DATABASE_URL`). Client: `cd client && npm run build`.

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
   código direto na `main`, um ticket = uma branch = um PR.
2. **Tabela nova entra no bloco RLS `isolamento_tenant`** (padrão das migrações 013/016/
   020/021/022) e ganha `UNIQUE (tenant_id, id)`. Fora do bloco = sem isolamento entre
   empresas, silenciosamente.
3. **Migração idempotente de verdade** — o histórico inteiro roda a cada deploy; "não dá
   erro ao repetir" não basta (backfills precisam de guarda).
4. **Nunca segure duas conexões do pool na mesma requisição.** O runtime da IA é dividido
   em 3 fases exatamente por isso (`server/ia/runtime.js`); `iaConfigStore.carregar()` NÃO
   recebe `conn`, `perfilStore.carregar(conn, ...)` recebe. Leia os cabeçalhos antes de mexer.
5. **Dois JWTs distintos de propósito**: sessão do cliente (`JWT_SECRET`, `token`) e do
   operador (`OPERADOR_JWT_SECRET`, `token_operador`) nunca se misturam — axios separados
   (`services/api.js` vs `services/apiOperador.js`). `IA_CRYPTO_KEY` é dedicada e estável.
6. **Não use a tabela `config` para dado sensível ou grande**: o GET devolve tudo a
   qualquer autenticado e o PUT trunca em 2.000 chars.
7. **Multi-tenant no webhook**: a Meta não manda tenant — resolve-se por `phone_number_id`
   (única unicidade global do schema). Um único webhook para todos os clientes.
8. **Texto de produto em PT-BR**, sem vocabulário da Multicanal (anti-referência do
   `PRODUCT.md`), e sem expor jargão de implementação na UI.
9. Camada 1 do prompt da IA (`BASE_SISTEMA` em `ia/perfilStore.js`) é **intocável por
   admin**: anti-alucinação, guarda de escopo, anti-injeção e sigilo — não enfraqueça.
10. Identificadores internos `falatta_*` (role do banco, migrações) são legado pré-rebrand
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

- `docs/WORKFLOW.md` — branch/commit/teste/PR (contrato)
- `docs/DEPLOY.md` — produção: Vercel (front) + Render (server) + Neon + R2
- `docs/SEGURANCA.md` · `docs/ESCALABILIDADE.md` · `docs/PORTE.md` (histórico do porte)
- `PRODUCT.md` (produto/marca) · `DESIGN.md` (visual)
- `docs/superpowers/specs/` — specs aprovadas por feature (IA: 4 fatias + handoff + upload)
- `docs/estudos/` — estudos (ex.: Meta Business Agent Platform)
