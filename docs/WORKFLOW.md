# WORKFLOW — como se trabalha neste repo

Regras de branch, commit, teste, PR e merge do **Falatta**. Vale para humano e
para agente. Se você é um agente autônomo tocando um ticket, este arquivo é
contrato — leia §1, §2, §3 e §4 **antes** de criar qualquer branch.

Antes de qualquer implementação, leia também [`PORTE.md`](PORTE.md): o repo é um
fork em porte e muita coisa que "parece pronta" ainda roda em Oracle
single-tenant.

---

## §1 Branches

Toda branch nasce de `origin/main` **fresca** (`git fetch origin main` antes de
cortar) e segue o padrão:

```
<tipo>/<descricao-curta-em-kebab-case>
```

Exemplos: `feat/embedded-signup` · `fix/rls-tenant-leak` · `chore/porte-pg-conversas`

- **Uma branch = um ticket = um PR.** Sem branch empilhada.
- **Nunca commite direto na `main`.**
- O Orca cria a worktree como `<usuario>/<nome>`; renomeie para o padrão acima
  **antes do primeiro push** (`git branch -m <tipo>/<descricao>`).
- Nunca renomeie depois do PR aberto via `git branch -m` + push — isso fecha o
  PR. Use *Rename branch* pela UI do GitHub, que reaponta.

## §2 Commits

Conventional Commits, descrição em português, imperativo, sem ponto final:

```
<tipo>(<escopo>): <descrição>
```

Tipos: `feat` · `fix` · `refactor` · `docs` · `chore` · `build` · `test`

Escopos: `porte` · `tenancy` · `auth` · `bot` · `ia` · `campanha` · `inbox` ·
`fila` · `realtime` · `admin` · `operador` · `meta` · `server` · `front`

```
feat(tenancy): RLS por tenant_id em conversa e mensagem
fix(porte): RETURNING no lugar de RETURNING INTO em contatos
refactor(auth): login em tabela própria, sem ERP externo
```

## §3 Testes — obrigatório antes do PR

```bash
cd server && npm test        # node:test — 225 testes hoje, todos verdes
cd client && npm run build   # se tocou o frontend
```

- **Só abra PR com a suíte verde de verdade.**
- Tocou lógica de negócio? Escreva teste. As funções de negócio são
  puras/injetáveis para testar sem banco nem rede — mantenha assim.
- **Multi-tenancy exige teste de vazamento.** Qualquer PR que mexa em query,
  pool ou sessão precisa provar que o tenant A não enxerga dado do tenant B.
  Ver a armadilha do `set_config` transaction-scoped em `PORTE.md` §1.2.
- Não há CI ainda. A verificação real é a suíte local + a review cruzada.

## §4 Pull Request

```bash
gh pr create --base main
```

- Sempre contra `main`; corpo com `Closes <ID>` do ticket.
- Descreva *o que mudou* e *como testar*. Mexeu em schema? Diga qual migração
  rodar e em que ordem.
- **Não faça merge. Não toque na `main`.** O merge é do humano e é o portão da
  próxima onda.

## §5 Dúvida durante a implementação

Se o ticket não responde uma decisão de escopo: **não chute**. Imprima uma linha
começando com `PERGUNTA:` e pare.

## §6 Banco de dados

- **PostgreSQL no Neon.** Migrações versionadas e numeradas, idempotentes,
  nunca editadas depois de aplicadas.
- `tenant_id` em toda tabela nova, com RLS habilitada. Sem exceção.
- SQL sempre parametrizado. Input de usuário **nunca** concatenado.
- Nunca use `SET SESSION` para escopo de tenant — só
  `set_config(..., true)`. Ver `PORTE.md` §1.2.
- `docs/referencia/schema-oracle/` é a DDL Oracle legada, **só para consulta**.

## §7 Nunca commitar

- `.env` (segredos da Meta, connection string do Neon, chaves de provedor de IA)
- `node_modules/`, `client/dist/`, `media/`, `logs/`

Já está tudo no `.gitignore` — se precisou de `git add -f`, pare e pergunte.

## §8 Orquestração em ondas (agentes)

Tocado com a skill `/orquestrar-projeto` — Claude implementa, Codex revisa,
humano mergeia.

- **Dependência entre tickets só existe em `blockedBy`.** Nunca inferida do
  título.
- Onda do ticket = `max(onda dos blockers) + 1`.
- Comentário de review é **insumo, não ordem**: correção confirmada no código
  vira commit na mesma branch; achado que contradiz o ticket vai pro humano.

## §9 Segurança

Todo ticket, PR e worker deste projeto segue [`SEGURANCA.md`](SEGURANCA.md).
O corpo do PR deve confirmar, item a item, os pontos do checklist que a
mudança tocou (ex.: "toca tenant/query → provei que o tenant A não lê dado do
B"; "toca rota de mutação → tem guarda de papel ou checagem de escopo"). Se
nenhum item se aplica, diga isso explicitamente no PR — não deixe em branco.
