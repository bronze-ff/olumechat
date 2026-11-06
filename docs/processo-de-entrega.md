# Processo de entrega

Este documento preserva o procedimento específico do Olume Chat. As regras gerais ficam no `AGENTS.md`; o runbook detalhado está em [`AMBIENTES.md`](AMBIENTES.md).

## Ciclo de entrega

1. Registre a necessidade em uma issue com escopo, fora de escopo e critérios de aceite.
2. Crie uma worktree a partir de `origin/main` fresca, implemente e execute a suíte.
3. Abra PR contra `main`, trate os achados de revisão e aguarde CI e revisão limpas.
4. Após o merge, a CI publica a imagem `sha-<commit>` e staging sobe automaticamente.
5. Valide staging e promova pelo workflow **Deploy produção**, informando o SHA validado e aprovando a etapa manual.
6. Produção recebe a mesma imagem validada em staging; faça o smoke dos três endereços.

Antes de validar staging, confirme a versão: `api-staging.olumechat.com.br/health/ready` deve declarar o commit e `https://staging.olumechat.com.br/version.json` deve ter a tag do deploy. Se divergir ou retornar `"origem": "desconhecida"`, pare.

- Funcionalidade nova: exercite o caminho novo com dados de staging.
- Landing: confira o visual e o formulário de lead de ponta a ponta no painel de staging.
- Correção: reproduza o defeito e confirme que desapareceu.

Urgência encurta a validação, mas não elimina PR, CI ou staging. Rollback devolve código, não schema; por isso migrações seguem expand/contract. Staging automático e promoção aprovada mantêm separado o ato de subir do de lançar.

## Branches, commits e PRs

Use `<tipo>/<descricao-curta-em-kebab-case>`. Não renomeie uma branch já aberta por `git branch -m`; use a interface do GitHub para preservar o PR. Evite PR empilhado. Se houver dependência, registre-a explicitamente; comentário de revisão é evidência, não ordem de mudança.

Commits seguem Conventional Commits em português, no imperativo. Escopos usuais: `porte`, `tenancy`, `auth`, `bot`, `ia`, `campanha`, `inbox`, `fila`, `realtime`, `admin`, `operador`, `meta`, `server` e `front`.

O PR descreve o que mudou, como testar e, quando houver schema, qual migração executar e em que ordem. Se uma decisão de escopo não estiver definida, registre `PERGUNTA:` e pare; não suponha.

## Validação

Execute a suíte correspondente e só abra PR com resultado verde. Toda mudança de lógica de negócio requer teste; mantenha as funções puras e injetáveis quando possível.

Mudança em query, pool ou sessão precisa provar que o tenant A não vê dados do tenant B. Localmente, testes sem `TEST_DATABASE_URL` podem ser pulados; na CI, `server-test-rls` inicia Postgres 16, executa `npm run migrar` e roda com `RLS_OBRIGATORIO=1`, que falha se houver teste pulado.

Para reproduzir esse cenário localmente, use um Postgres descartável:

```bash
cd server
DATABASE_URL=postgres://user:senha@localhost:5432/olume npm run migrar
TEST_DATABASE_URL=postgres://user:senha@localhost:5432/olume RLS_OBRIGATORIO=1 npm test
```

## Banco, ambientes e deploy

PostgreSQL no Neon usa uma branch por ambiente (`main`, `staging` e `production`). Migrações são versionadas, numeradas, idempotentes e nunca editadas depois de aplicadas. Migração arriscada deve ser testada em branch efêmera do Neon criada a partir de `production` e descartada em seguida.

Toda tabela nova tem `tenant_id` e RLS. SQL é parametrizado; não concatene entrada de usuário. Não use `SET SESSION` para escopo de tenant: use `set_config(..., true)`. `docs/referencia/schema-oracle/` é somente consulta.

Ambientes não compartilham banco, bucket ou segredo. Variáveis `VITE_*` são de build: alterá-las requer rebuild. Migrações rodam no entrypoint antes de o servidor ficar pronto; falha mantém a versão anterior atendendo. A promoção normal é pelo workflow; Coolify serve para diagnóstico e emergência, conforme o runbook.

Não comite `.env`, `node_modules/`, `client/dist/`, `media/` ou `logs/`. Se for necessário `git add -f`, pare e peça orientação.

## Segurança no PR

Consulte [`SEGURANCA.md`](SEGURANCA.md). O PR confirma, item a item, o que foi verificado para cada requisito tocado; quando nenhum se aplicar, declare isso explicitamente.
