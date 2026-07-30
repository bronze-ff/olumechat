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
via terminal do container `backend-staging`).

**Painel do Coolify** — `https://ops.olumechat.com.br`, também atrás do Access. Dali saem
deploys, logs e rollback dos quatro aplicativos (`frontend`, `backend`, `frontend-staging`,
`backend-staging`).

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

### Três regras que evitam quase toda dor

- **Migração expand/contract.** Release N adiciona a coluna e passa a escrever nos dois
  lugares; release N+1 remove a antiga. É o que permite reverter o código sem reverter o
  banco — e reverter banco com cliente escrevendo é o pior cenário possível.
- **Feature flag para mudança grande.** O código sobe desligado e você liga por tenant.
  "Subir" e "lançar" viram eventos separados: deu ruim, desliga a flag em segundos.
- **Nunca clone dado real para staging sem anonimizar.** Lá dentro há conversa de WhatsApp,
  telefone e documento de cliente.

## Operação

**Deploy manual** (enquanto a automação da Onda 8 não existe): Coolify → aplicação → Deploy.
Ou pela API, de dentro da VPS:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/v1/deploy?uuid=<uuid-da-aplicacao>&force=false"
```

**UUIDs das aplicações:** `frontend` `a13t9isqpv2kvk81icw31sd7` · `backend`
`mwt9ycir685u4xvp3audof54` · `frontend-staging` `r130mr3erjseqn4shqdpnw2b` ·
`backend-staging` `tnrnbyz08x1cgvwdkndwo8es`.

**Rollback:** Coolify → aplicação → Rollback → escolher o deploy anterior. Migrações **não**
são revertidas automaticamente (por isso expand/contract).

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
