# Olume Chat — atendimento por WhatsApp, multi-empresa

Status: em produção (`https://olumechat.com.br`, API em `https://api.olumechat.com.br`). Staging em `https://staging.olumechat.com.br`.

Stack: React 18 e Vite no `client/`, Express no `server/`, Postgres no Neon, mídia no Cloudflare R2, deploy na VPS com Coolify.

Dono: Filippe.

## Como rodar (dev)

PowerShell, na raiz do repositório. É preciso um `server/.env` com `DATABASE_URL` de uma branch Neon descartável (copie de `server/.env.example`).

```powershell
Copy-Item server\.env.example server\.env
Copy-Item client\.env.example client\.env
cd server
npm install
npm run migrar
npm run dev
```

Outro terminal:

```powershell
cd client
npm install
npm run dev
```

O painel abre em `http://localhost:5173`. A API escuta na porta 3001. O Vite encaminha `/api` para lá.

Antes de abrir PR, na raiz:

```powershell
npm run verify
```

Isso roda a suíte do server e o teste mais o build do client.

## Como publicar

O merge na `main` sobe staging. Produção é promoção manual da mesma imagem. Runbook: [`docs/operacao.md`](docs/operacao.md) e [`docs/AMBIENTES.md`](docs/AMBIENTES.md).

## Estrutura

| Pasta | O que é |
|---|---|
| `client/` | Telas |
| `server/` | API, webhook, fila, IA |
| `docs/` | Funcionalidades, arquitetura, operação, decisões |
| `.github/workflows/` | CI, imagem no GHCR, staging e promoção |

## Documentação

- [`docs/funcionalidades.md`](docs/funcionalidades.md) — o que o sistema faz, por tela
- [`docs/arquitetura.md`](docs/arquitetura.md) — pastas, dados e integrações
- [`docs/operacao.md`](docs/operacao.md) — deploy, variáveis, rollback
- [`docs/decisoes/`](docs/decisoes/) — decisões registradas
- [`docs/produto/PRODUCT.md`](docs/produto/PRODUCT.md) e [`docs/produto/DESIGN.md`](docs/produto/DESIGN.md) — vocabulário e visual
