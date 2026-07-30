# Deploy automatizado — build único, promoção por aprovação

**Data:** 2026-07-30
**Contexto:** hoje o deploy é manual. Eu chamo a API do Coolify por SSH, e o
Coolify clona o repositório e **constrói a imagem na própria VPS**.

## O que está errado hoje

1. **Deploy depende de mim estar presente.** Não há gatilho automático.
2. **O repositório vai virar privado no sábado.** Origem "Public Repository"
   deixa de clonar e *todo deploy quebra*. A saída conhecida era instalar um
   GitHub App no Coolify — trabalho manual que este desenho torna desnecessário.
3. **Produção recebe um *rebuild*, não o artefato validado em staging.** São dois
   `docker build` distintos, em momentos distintos, com caches distintos.
   "Passou em staging e quebrou em produção" nasce exatamente daqui.
4. **O build acontece na VPS**, disputando CPU e memória com a produção que está
   servindo cliente.

## Desenho

O CI passa a ser o **único** construtor de imagem. O Coolify deixa de construir e
passa a **puxar** imagem pronta do GHCR (GitHub Container Registry).

```
merge na main
   │
   ├─ CI: testes + audit + build  ──(se verde)──►  push no GHCR
   │                                                 :sha-<commit>
   │
   ├─ deploy AUTOMÁTICO em staging  (aponta as apps para :sha-<commit>)
   │
   ▼
Filippe valida staging.olumechat.com.br
   │
   ├─ Actions → "Promover para produção" → informa o SHA → Approve
   │
   ▼
produção recebe A MESMA imagem, byte a byte
```

### Tags

| Imagem | Conteúdo |
|---|---|
| `ghcr.io/bronze-ff/olumechat-server:sha-<commit>` | backend, idêntico nos dois ambientes |
| `ghcr.io/bronze-ff/olumechat-client-staging:sha-<commit>` | frontend com `VITE_API_URL=api-staging` |
| `ghcr.io/bronze-ff/olumechat-client-prod:sha-<commit>` | frontend com `VITE_API_URL=api` |

Duas imagens de frontend do **mesmo commit** porque `VITE_*` é build-time: o Vite
embute a URL no bundle. Não dá para promover um bundle de staging para produção —
ele apontaria para a API errada. O backend não tem esse problema: a configuração
dele vem do ambiente em tempo de execução, então a imagem é genuinamente a mesma.

**Só tags imutáveis.** Nada de `:latest` ou `:staging` móvel. A cada deploy o
workflow grava o nome exato da imagem na aplicação do Coolify (via API) e só então
dispara. Assim "o que está rodando em produção" é uma pergunta com resposta exata,
e rollback é apontar para um SHA anterior — sem rebuild, sem ambiguidade de cache.

### Como o CI alcança o Coolify

A API do Coolify escuta em `localhost:8000` e está bloqueada de fora pela regra
`DOCKER-USER`. A porta pública é `ops.olumechat.com.br`, atrás do Cloudflare Access.

O CI entra por um **Service Token do Cloudflare Access**: o workflow manda os
cabeçalhos `CF-Access-Client-Id` e `CF-Access-Client-Secret`, o Access valida e
deixa passar. Nenhuma porta nova, nenhuma chave SSH no GitHub.

### Por que produção não é automática

Staging automático e produção sob aprovação separa **subir** de **lançar**. O
GitHub Environment `production` exige revisor (Filippe); enquanto ele não aprova,
o job fica parado. Fica registrado quem promoveu, quando e qual SHA.

### O que este desenho NÃO resolve

**Rollback de imagem não reverte migração.** O entrypoint roda as migrações no
boot; voltar para um SHA antigo devolve o código, não o schema. É por isso que
`expand/contract` continua obrigatório (docs/AMBIENTES.md).

## Fatiamento

| Ticket | Escopo |
|---|---|
| FIL-99 | CI constrói e publica as três imagens no GHCR, com tag imutável |
| FIL-100 | Coolify consome GHCR; deploy automático em staging após CI verde |
| FIL-101 | Workflow de promoção para produção com aprovação, e rollback por SHA |

FIL-100 depende de FIL-99; FIL-101 depende de FIL-100.

## Segredos

| Onde | Nome | Origem |
|---|---|---|
| GitHub Actions | `COOLIFY_TOKEN` | token de API do Coolify (escopo de deploy) |
| GitHub Actions | `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | service token do Cloudflare Zero Trust |
| GitHub Actions | — para o GHCR | `GITHUB_TOKEN` embutido, com `packages: write` |
| Coolify | credencial de registry | PAT do GitHub com **apenas** `read:packages` |

O PAT é o único item que exige o Filippe: só a conta dona pode emiti-lo.
