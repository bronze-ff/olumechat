# WORKFLOW — como se trabalha neste repo

Regras de branch, commit, teste, PR e merge do **Olume**. Vale para humano e
para agente. Se você é um agente autônomo tocando um ticket, este arquivo é
contrato — leia §1, §2, §3 e §4 **antes** de criar qualquer branch.

**O sistema está em produção** (`olumechat.com.br`), com ambiente de staging
espelhado. Antes de qualquer implementação, leia [`AMBIENTES.md`](AMBIENTES.md):
onde cada ambiente roda, como acessar e como uma mudança viaja de dev → staging →
produção. `PORTE.md` é histórico do porte Oracle→Postgres, só para consulta.

---

## §0 O ciclo completo — do pedido ao ar

O mapa. As seções seguintes detalham cada etapa; esta responde "como uma ideia
vira produção, e o que cabe a quem".

**Vale igual para funcionalidade nova, mexida na landing e correção de bug.** O
que muda é só o *passo 8* — o que se valida em staging.

| # | O quê | Quem |
|---|---|---|
| 1 | Descrever o que se quer | humano |
| 2 | Ticket no Linear, com escopo, fora-de-escopo e critérios de aceite | orquestrador |
| 3 | Worktree de `origin/main` fresca; worker implementa e roda a suíte | agente |
| 4 | PR contra `main` (§4) + review cruzada do Codex + triagem dos achados | agente |
| 5 | **Merge** | **humano** |
| 6 | CI roda os checks obrigatórios; se verde, publica `sha-<commit>` no GHCR | automático |
| 7 | Staging sobe sozinho com esse SHA | automático |
| 8 | **Validar em staging** | **humano** |
| 9 | Actions → *Deploy produção* → informar o SHA validado | **humano** |
| 10 | O job para e pede aprovação; aprovar libera | **humano** |
| 11 | Produção recebe a mesma imagem + smoke nos três endereços | automático |

O humano faz três cliques e uma validação. Tudo entre 5 e 11 corre sozinho.

### O que validar no passo 8

**Antes de qualquer coisa, confirme que você está olhando a versão nova.** A API já é
provada automaticamente (o deploy falha se `api-staging.olumechat.com.br/health/ready` não
declarar o commit deployado). O **frontend não é** — a landing de staging está atrás do
Cloudflare Access sem exceção de caminho, e abrir uma só para o smoke trocaria uma garantia
por um risco. Então abra `https://staging.olumechat.com.br/version.json` no navegador (o
Access deixa você passar) e compare `tag` com a tag do deploy — ela está no resumo da
execução do workflow. Divergiu, ou veio `"origem": "desconhecida"`? **Pare**: o que você
validaria a seguir seria outra versão. Detalhe em [`AMBIENTES.md`](AMBIENTES.md).

- **Funcionalidade nova** — exercitar o caminho novo. O banco de staging é
  outro, então pode criar dado à vontade; nada disso aparece em produção.
- **Landing page** — abrir `staging.olumechat.com.br`, conferir o visual e
  testar o formulário de lead ponta a ponta (o lead tem que aparecer no painel
  do operador de staging).
- **Correção de bug** — **reproduzir o bug** e confirmar que sumiu. É a
  validação mais importante das três: um fix que ninguém tentou quebrar é uma
  hipótese, não uma correção.

### Urgência

Produção quebrada encurta o caminho, não o portão: o PR continua existindo e a
CI continua sendo obrigatória, mas a validação em staging vira uma conferência
rápida e a promoção acontece em seguida. Se a correção piorar, o rollback é o
mesmo workflow do passo 9 com um SHA anterior — minutos.

**Rollback devolve o código, não o schema.** Migração não é revertida
automaticamente. É por isso que expand/contract (§6) é obrigatório.

### Por que produção não sobe sozinha

Staging automático e produção sob aprovação separam **subir** de **lançar**.
Fica registrado quem promoveu, quando e qual versão exata — e existe um momento
explícito em que alguém olha para staging e decide. Deploy automático até
produção economizaria um clique e removeria a única etapa que exige julgamento.

### Estado atual

O ciclo inteiro já funciona assim: a CI publica as imagens (FIL-99), o
`deploy-staging.yml` leva o `sha-<commit>` para staging sozinho (FIL-100), a API
e o frontend declaram qual build estão servindo (FIL-113) e o
`deploy-producao.yml` promove sob aprovação (FIL-101). O desenho está em
[`superpowers/specs/2026-07-30-deploy-automatizado-design.md`](superpowers/specs/2026-07-30-deploy-automatizado-design.md).

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
cd server && npm test        # node:test — 1.000+ testes, todos verdes
cd client && npm run build   # se tocou o frontend
```

- **Só abra PR com a suíte verde de verdade.**
- Tocou lógica de negócio? Escreva teste. As funções de negócio são
  puras/injetáveis para testar sem banco nem rede — mantenha assim.
- **Multi-tenancy exige teste de vazamento.** Qualquer PR que mexa em query,
  pool ou sessão precisa provar que o tenant A não enxerga dado do tenant B.
  Ver a armadilha do `set_config` transaction-scoped em `PORTE.md` §1.2.
- **A CI é obrigatória e bloqueia o merge.** A `main` é protegida e exige **7 checks**
  verdes: `server-test`, `server-test-rls`, `client-build`, `npm-audit (server)`,
  `npm-audit (client)`, `backend-image` e `frontend-image`. A suíte local
  continua sendo o primeiro filtro — a CI é o juiz, porque roda em ambiente
  limpo.

### Testes de RLS contra Postgres real — obrigatórios na CI (FIL-98)

Os testes de isolamento entre tenants só existem com banco de verdade: sem
`TEST_DATABASE_URL` o `node:test` os marca como `skipped` e a suíte termina
verde **sem ter provado nada**. No laptop isso é aceitável (`npm test` sem
banco continua sendo o filtro rápido). Na CI, não:

- o job `server-test-rls` levanta um Postgres 16, roda `npm run migrar` e
  executa a suíte inteira com `TEST_DATABASE_URL` apontando para ele;
- com `RLS_OBRIGATORIO=1`, o `test/run-tests.js` **falha se qualquer teste for
  pulado** e lista no log os testes que rodaram contra o banco real. Teste que
  não roda não pode se disfarçar de teste que passou;
- consequência prática: um PR que remova uma policy, deixe uma tabela sem RLS
  ou vaze dado entre tenants **fica vermelho na CI**.

Quer rodar igual à CI na sua máquina? Suba um Postgres qualquer, aplique as
migrações e:

```bash
cd server
DATABASE_URL=postgres://user:senha@localhost:5432/olume npm run migrar
TEST_DATABASE_URL=postgres://user:senha@localhost:5432/olume RLS_OBRIGATORIO=1 npm test
```

## §4 Pull Request

```bash
gh pr create --base main
```

- Sempre contra `main`; corpo com `Closes <ID>` do ticket.
- Descreva *o que mudou* e *como testar*. Mexeu em schema? Diga qual migração
  rodar e em que ordem.
- **Não faça merge. Não toque na `main`.** O merge é do humano e é o portão da
  próxima onda.

### Depois do merge: staging sobe sozinho, você valida, você promove

Resumo dos passos 6 a 11 da §0. Merge na `main` **não** é lançamento. O caminho é:

1. **staging sobe sozinho** com o commit mergeado, assim que a CI fica verde —
   ninguém dispara nada. Guarde a tag `sha-<curto>` do resumo da execução;
2. **valide em `staging.olumechat.com.br`** com dados de teste, conferindo antes
   que você está olhando a versão nova (`/version.json`);
3. **promova pelo Actions** → *Deploy produção* → informe aquele SHA → o job para
   e pede aprovação → aprovado, produção recebe **a mesma imagem** validada, nunca
   um rebuild.

Deu ruim depois de promover? O mesmo workflow com o SHA anterior e
`primeiro: frontend` devolve a versão antiga — mas devolve o **código**, não o
**schema** (§6). A ordem invertida no rollback tem motivo, explicado em
[`AMBIENTES.md`](AMBIENTES.md).

Mudança que só toca documentação pode ir direto. Qualquer coisa que toque código,
schema ou configuração passa por staging. Ver [`AMBIENTES.md`](AMBIENTES.md).

## §5 Dúvida durante a implementação

Se o ticket não responde uma decisão de escopo: **não chute**. Imprima uma linha
começando com `PERGUNTA:` e pare.

## §6 Banco de dados

- **PostgreSQL no Neon**, uma branch por ambiente (`production`, `staging`,
  `main` para dev). Migrações versionadas e numeradas, idempotentes, nunca
  editadas depois de aplicadas — elas rodam **todas** no boot de cada deploy.
- **Expand/contract obrigatório com produção no ar.** Release N adiciona coluna e
  escreve nos dois lugares; release N+1 remove a antiga. Nunca remova na mesma
  release que parou de usar: é o que permite reverter código sem reverter banco.
- **Migração arriscada testa em branch efêmera do Neon** criada a partir da
  `production` — dados reais, risco zero, descarta depois.
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

Tocado com a skill global `orquestrar-projeto` (`/orquestrar-projeto` no Claude e
`$orquestrar-projeto` no Codex), que lê este arquivo e os demais contratos locais antes
de montar o DAG — Claude implementa, Codex revisa,
humano mergeia.

- **Dependência entre tickets só existe em `blockedBy`.** Nunca inferida do
  título.
- Onda do ticket = `max(onda dos blockers) + 1`.
- Comentário de review é **insumo, não ordem**: correção confirmada no código
  vira commit na mesma branch; achado que contradiz o ticket vai pro humano.

## §9 Ambientes e deploy

Detalhe completo em [`AMBIENTES.md`](AMBIENTES.md). O essencial para quem
implementa:

- **Produção está no ar com clientes potenciais vendo.** Nada vai para lá sem
  passar por staging.
- **Nunca aponte um ambiente para o banco ou bucket do outro.** Cada um tem
  connection string, bucket e segredos próprios — inclusive `JWT_SECRET` e
  `IA_CRYPTO_KEY` diferentes, de propósito.
- **Nunca commite valor de variável de ambiente**, nem em exemplo. O
  `.env.example` leva placeholders.
- **Staging sobe sozinho** a cada merge com CI verde; **produção só sobe por
  aprovação**: Actions → *Deploy produção* → o SHA que você validou em staging →
  aprovar. **Rollback é o mesmo workflow com um SHA anterior e
  `primeiro: frontend`.** O Coolify
  (`ops.olumechat.com.br`) continua servindo para diagnóstico e para o
  procedimento de emergência, não para o deploy do dia a dia.
- Migração roda no entrypoint do container, **antes** do servidor subir: falhou, o
  container não fica pronto e a versão anterior continua atendendo. E rollback de
  imagem **não** reverte migração — devolve o código, não o schema.
- Variáveis `VITE_*` são **build-time**: mudou o valor, precisa rebuildar.

## §10 Segurança

Todo ticket, PR e worker deste projeto segue [`SEGURANCA.md`](SEGURANCA.md).
O corpo do PR deve confirmar, item a item, os pontos do checklist que a
mudança tocou (ex.: "toca tenant/query → provei que o tenant A não lê dado do
B"; "toca rota de mutação → tem guarda de papel ou checagem de escopo"). Se
nenhum item se aplica, diga isso explicitamente no PR — não deixe em branco.
