# Ambientes — produção, staging e desenvolvimento

Três ambientes isolados. **Nenhum segredo, banco ou bucket é compartilhado entre eles.**

## Mapa

| | Desenvolvimento | Staging | Produção |
|---|---|---|---|
| Onde roda | sua máquina | VPS (Coolify, ambiente `staging`) | VPS (Coolify, ambiente `production`) |
| Frontend | `localhost:5173` | `staging.olumechat.com.br` | `olumechat.com.br` |
| Backend | `localhost:3001` | `api-staging.olumechat.com.br` | `api.olumechat.com.br` |
| Acesso | local | **Cloudflare Access** (só e-mail autorizado) | público |
| Banco (Neon) | branch `main` | branch `staging` | branch `production` |
| Mídia | disco local (`STORAGE_DRIVER=local`) | bucket `olume-media-staging` | bucket `olume-media-prod` |
| Origem da imagem | build local | **imagem do GHCR** (`sha-<commit>`) | **imagem do GHCR** (`sha-<commit>`) |
| Segredos | `server/.env` | próprios, no Coolify | próprios, no Coolify |
| Código | sua branch de feature | `main` (após merge) | a mesma imagem validada em staging |

Infra comum aos dois ambientes hospedados: VPS Hostinger (`179.198.105.75`), Coolify em
`ops.olumechat.com.br` (atrás do Access), Cloudflare como DNS/proxy/TLS.

## Como acessar

**Produção** — `https://olumechat.com.br`; painel do operador com a conta criada via
`npm run criar-operador`. A API responde em `https://api.olumechat.com.br`
(`/health/live` e `/health/ready` são públicos).

**Staging** — `https://staging.olumechat.com.br`. O Cloudflare Access pede seu e-mail e
envia um código antes de qualquer coisa carregar. E-mails autorizados hoje:
`filippe.ffr@gmail.com`, `ferferbrito@gmail.com`, `admin@olumechat.com.br`.
Como o banco é outro, **é preciso criar um operador próprio de staging** (mesma receita,
via terminal do container `backend-staging-img`).

**Painel do Coolify** — `https://ops.olumechat.com.br`, também atrás do Access. Dali saem
deploys, logs e rollback dos aplicativos (`frontend`, `backend`, `frontend-staging-img`,
`backend-staging-img`).

**Servidor** — `ssh -i ~/.ssh/olume-vps root@179.198.105.75` (só por chave; senha
desabilitada). Portas abertas: 22, 80, 443 — e só.

## Fluxo de uma funcionalidade nova

1. Ticket no Linear → branch `<tipo>/<descricao>` cortada de `origin/main` **fresca**.
2. Desenvolva local, contra o Neon `main`. Migração arriscada? Crie uma **branch efêmera do
   Neon a partir da `production`**, rode a migração lá, confira com o formato de dados real
   e descarte. Custo zero.
3. PR → CI verde (`server-test` + `server-test-rls` + `client-build`, exigidos pela proteção da `main`) → review
   cruzada → merge.
4. **Deploy em staging** e validação com dados de teste.
5. **Promoção para produção**: publique a **mesma imagem** validada em staging — nunca um
   rebuild. Rebuildar é a forma clássica de "passou em staging e quebrou em produção".

O ciclo completo, com quem faz cada passo, está na **§0 do [`WORKFLOW.md`](WORKFLOW.md)**.

### Três regras que evitam quase toda dor

- **Migração expand/contract.** Release N adiciona a coluna e passa a escrever nos dois
  lugares; release N+1 remove a antiga. É o que permite reverter o código sem reverter o
  banco — e reverter banco com cliente escrevendo é o pior cenário possível.
- **Feature flag para mudança grande.** O código sobe desligado e você liga por tenant.
  "Subir" e "lançar" viram eventos separados: deu ruim, desliga a flag em segundos.
- **Nunca clone dado real para staging sem anonimizar.** Lá dentro há conversa de WhatsApp,
  telefone e documento de cliente.

## Operação

### De onde vem a imagem

**Nada mais compila na VPS.** Staging desde 2026-07-30 e produção desde 2026-07-31, todas
as aplicações são do tipo `dockerimage`: elas **puxam** do GHCR a imagem que a CI construiu
e testou.

Isso resolve dois problemas de uma vez: o build sai da VPS (que estava disputando CPU com a
produção no ar) e o Coolify deixa de precisar de acesso ao repositório — o que importa
quando o repositório virar privado.

**A cada push na `main`, a CI publica três imagens** com tag imutável `sha-<commit>`:

| Imagem | Onde roda |
|---|---|
| `ghcr.io/bronze-ff/olumechat-server` | backend, idêntica nos dois ambientes |
| `ghcr.io/bronze-ff/olumechat-client-staging` | frontend de staging |
| `ghcr.io/bronze-ff/olumechat-client-prod` | frontend de produção |

São **duas** imagens de frontend do mesmo commit porque `VITE_API_URL` é build-time: o Vite
embute a URL da API no bundle, então o bundle de staging apontaria para a API errada se
fosse promovido. Por isso as aplicações de frontend **não têm variáveis `VITE_*` no
Coolify** — seriam configuração inerte, enganando quem lesse depois.

A VPS está autenticada no GHCR (`docker login`, credencial em `/root/.docker/config.json`).

### Deploy manual

Coolify → aplicação → Deploy. Ou pela API, de dentro da VPS:

```bash
# aplicação por imagem: aponte a tag ANTES de disparar
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "http://localhost:8000/api/v1/applications/<uuid>" \
  -d '{"docker_registry_image_tag":"sha-abc1234"}'

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/v1/deploy?uuid=<uuid>&force=false"
```

**UUIDs:**

| Aplicação | UUID | Tipo |
|---|---|---|
| `frontend-prod-img` | `wjwktcp2rti9ioplif11f8ss` | **dockerimage** |
| `backend-prod-img` | `psken5bkmwvyqobktly7tqnj` | **dockerimage** |
| `frontend-staging-img` | `ywvuaupjy85ubam5w9z79tz9` | **dockerimage** |
| `backend-staging-img` | `jhp3osrkx1f3iu70c9imzmy1` | **dockerimage** |

**Os quatro ambientes rodam por imagem** desde 2026-07-31. Nenhum compila na VPS.

As aplicações antigas — `frontend`/`backend` (`a13t9isqpv2kvk81icw31sd7`,
`mwt9ycir685u4xvp3audof54`) e `frontend-staging`/`backend-staging`
(`r130mr3erjseqn4shqdpnw2b`, `tnrnbyz08x1cgvwdkndwo8es`) — compilavam do Dockerfile e estão
com os containers **parados** (`docker stop`) e sem domínio, mantidas como rollback. Apontar um deploy para elas "funciona" sem trocar nada do que está no ar — falha
silenciosa, a pior categoria.

**Rollback:** com aplicação por imagem, é apontar `docker_registry_image_tag` para um
`sha-` anterior e disparar. Sem rebuild e sem ambiguidade de cache. Migrações **não** são
revertidas automaticamente — rollback devolve o código, não o schema (por isso
expand/contract).

### Trocar uma aplicação para o tipo imagem

Uma aplicação que compila do Dockerfile **não pode ser convertida**: o enum `BuildPackTypes`
do Coolify não inclui `dockerimage`, que só nasce pela rota `POST /applications/dockerimage`.
É preciso **recriar** — e o UUID muda. Receita já executada em staging:

1. Criar a nova aplicação pela rota de imagem, **sem domínio**. Ela sobe em paralelo, sem
   receber tráfego.
2. Copiar as variáveis de ambiente **por dentro do Coolify** (`php artisan tinker`,
   modelo `EnvironmentVariable`, colunas polimórficas `resourceable_id` /
   `resourceable_type`). A **API não devolve os valores** das variáveis — migrar por ela
   cria um ambiente com credenciais vazias, e a falha aparece longe da causa.
3. Apagar as cópias `is_preview = true` que o Coolify cria sozinho, senão o ambiente novo
   fica diferente do antigo.
4. Deployar e provar saúde **batendo direto no IP do container**, antes de qualquer
   tráfego. Falhou aqui, ninguém percebeu: o antigo continua atendendo.
5. Só então mover o domínio (remover do antigo, gravar no novo) e redeployar para o Traefik
   pegar os labels.
6. **`docker stop` no container antigo.** Este passo não é opcional e não é limpeza —
   ver o aviso abaixo.
7. Manter o antigo parado alguns dias como rollback; só depois apagar.

> **Remover o domínio na configuração NÃO tira o container do roteamento.**
>
> Os labels do Traefik são gravados no container **no momento em que ele é criado**.
> Mudar a configuração da aplicação no Coolify não reescreve o label de um container que
> já está rodando. Enquanto o antigo estiver de pé, ele continua anunciando
> `Host(...)` para o mesmo domínio, e o Traefik passa a ter **dois serviços disputando o
> mesmo host**. Ele escolhe um — e pode escolher o antigo.
>
> O sintoma é cruel: o deploy termina verde, o container novo está saudável, o
> `/health` responde 200, e mesmo assim o navegador mostra a versão velha. Parece cache,
> e não é. Aconteceu de verdade na conversão do staging em 2026-07-31.
>
> Como confirmar quem está servindo, sem depender do navegador:
>
> ```bash
> # todos os containers que reivindicam algum host
> for c in $(docker ps --format '{{.Names}}'); do
>   docker inspect $c --format '{{json .Config.Labels}}' | grep -oE 'Host\(`[^`]+`\)' | sed "s|^|$c -> |"
> done
>
> # qual bundle o Traefik realmente entrega (compare com o do container novo)
> curl -sk --resolve <dominio>:443:127.0.0.1 https://<dominio>/ | grep -oE 'assets/[^"]+\.js'
> ```
>
> Testar por dentro do container (`docker exec`) prova que a imagem está certa, mas
> **não** prova que é ela que o mundo recebe. A verificação que vale é através do Traefik.

Em produção isso é **blue-green** e não precisa de janela de manutenção — a
indisponibilidade real é a troca de domínio, alguns segundos. Atenção a um detalhe: o
backend roda migração no boot, então a aplicação nova aplica migrações enquanto a antiga
ainda atende. Sendo a mesma imagem, é no-op; com migração nova, as duas versões convivem
por alguns minutos contra o mesmo schema — que é precisamente o que expand/contract existe
para tornar seguro.

**Backup:** dump do banco do Coolify + `.env` todo dia às 04:00 UTC em `/root/backups`
(7 últimos). O Neon tem PITR próprio; o R2 guarda a mídia.

## Armadilhas conhecidas

- **Health check da UI do Coolify fica desligado** de propósito: a imagem do backend é slim e
  não tem `curl`/`wget`. Quem checa é o `HEALTHCHECK` do Dockerfile, escrito em Node.
- **`Ports Exposes` precisa ser preenchido** (10000 no backend, 80 no front). Vazio, o Coolify
  assume 3000 e o Traefik responde "no available server".
- **Migração exige URL direta do Neon** (sem `-pooler`): o lock de sessão não funciona através
  do pooler em transaction mode.
- **Variáveis `VITE_*` são build-time.** Mudou o valor? Precisa **rebuildar**, não basta
  reiniciar — o Vite embute no bundle.
- **O Access bloqueia webhooks** do GitHub para o `ops.`. É esperado: o deploy é disparado por
  API/CI, não por push.
