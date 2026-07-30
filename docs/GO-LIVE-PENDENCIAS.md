# Go-live — o que já está pronto e o que falta

**Atualizado:** 2026-07-30, após a subida de produção.

## Já está em produção e validado

| Item | Endereço / estado |
|---|---|
| Landing | `https://olumechat.com.br` — TLS, CDN, SPA fallback, `www` canônico, HTTP→HTTPS |
| Backend | `https://api.olumechat.com.br` — `/health/live` e `/health/ready` em 200 |
| Painel do operador | acessível, operador de produção criado |
| Painel do Coolify | `https://ops.olumechat.com.br` atrás do Cloudflare Access |
| Banco | Neon branch `production` (limpa) · `staging` · `main` (dev local) |
| Migrações | 001→024 aplicadas no boot, 48 tabelas com RLS |
| Mídia | R2 `olume-media-prod` e `olume-media-staging`, token restrito aos buckets |
| Firewall | 3 camadas: UFW, `DOCKER-USER`, painel Hostinger (22/80/443 apenas) |
| SSH | só por chave, senha desabilitada, updates automáticos |
| Segurança da API | CORS restrito ao `APP_URL`, rotas protegidas 401, webhook recusa token inválido |
| CI | testes + build + imagens Docker, e `main` protegida exigindo os checks |

## Pendências — do FILIPPE

### 1. GitHub App no Coolify (ANTES DE SÁBADO — bloqueante)
Quando o repositório virar privado, a origem "Public Repository" para de clonar e **todo deploy falha**.
- Coolify → **Sources → + Add → GitHub App** → instalar na conta `bronze-ff`, autorizar `olumechat`
- Em cada aplicação (`frontend` e `backend`): trocar a origem para essa source
- **Deixar auto-deploy DESLIGADO** (o deploy será disparado pelo CI, não pelo push)

### 2. Conta Meta Business + verificação (dias)

> **FIL-97 destravou a venda enquanto isso.** A verificação da Meta exige CNPJ, que a
> Olume ainda não tem — e sem app próprio nenhum cliente entraria. Agora o sistema também
> suporta **um app da Meta por cliente**: o cliente usa o app DELE (App ID, App Secret e
> token permanente), e o operador cadastra isso na sessão de suporte, em
> **Canais → App da Meta deste cliente**. Cada cliente recebe ali uma **URL de webhook
> exclusiva** (`https://api.olumechat.com.br/webhook/<32 hex>`) para colar no app dele,
> com o mesmo `WEBHOOK_VERIFY_TOKEN` de sempre.
>
> Isto **não substitui** o item abaixo: o app da plataforma continua sendo o destino
> final. Quando ele existir, clientes novos entram por Embedded Signup e os antigos
> migram um a um — os dois modelos convivem, sem big bang.

Continua sendo o caminho certo para escalar. Começar assim que houver CNPJ.
1. Criar conta em `business.facebook.com` com e-mail da Olume (precisa de uma conta pessoal do Facebook de um sócio como admin)
2. Submeter **verificação da empresa**: cartão CNPJ, razão social/endereço/telefone idênticos ao CNPJ, site oficial (`olumechat.com.br` já serve), e-mail do domínio
3. Criar o app em `developers.facebook.com` → adicionar produto **WhatsApp**
4. Copiar **App ID** e **App Secret** → me passar

### 3. Caixa de e-mail `admin@olumechat.com.br`
Foi usada no operador e na política do Cloudflare Access, mas provavelmente ainda não existe.
Criar na Hostinger (os registros MX/SPF/DKIM já estão configurados e em *DNS only*).

### 4. Antes do primeiro cliente REAL
- **Neon → plano Launch**: hoje o PITR é de 6 horas e o compute é fixo em 0,25 CU. Com dado de cliente, isso é risco.
- **Monitoramento externo** (UptimeRobot ou similar, plano grátis): vigiar `olumechat.com.br`, `api.olumechat.com.br/health/live` e `/health/ready`. Precisa ser externo — se a VPS cair inteira, o alerta tem que vir de fora.
- **Repositório de volta a privado** (sábado) — depois do item 1.

## Pendências — do CLAUDE (posso executar)

1. **Ambiente de staging completo** — `staging.olumechat.com.br` e `api-staging.olumechat.com.br` no Coolify, com a branch Neon `staging`, o bucket `olume-media-staging` e **segredos próprios** (nunca os de produção).
2. **Automação de deploy (Onda 8)** — GitHub Actions publicando imagem no GHCR e disparando o Coolify **só depois da CI verde**. Depende do item 1 do Filippe (GitHub App).
3. **Backup da configuração do Coolify** — rotina que exporta `/data/coolify` para fora da VPS.
4. **Smoke test completo (25 itens da §11 do DEPLOY_VPS.md)** — a parte que não depende da Meta já posso rodar; o resto quando o WhatsApp existir.
5. **Quando a Meta chegar:** trocar o placeholder do `META_APP_SECRET`, configurar o webhook (`https://api.olumechat.com.br/webhook`), validar assinatura e Embedded Signup.

## Ordem recomendada

```
HOJE      → Filippe: começa a conta Meta (demora dias, então começa já)
HOJE      → Claude: staging + backup do Coolify
ATÉ SÁB   → Filippe: GitHub App  →  Claude: automação de deploy
ATÉ SÁB   → Filippe: repo privado
DIAS      → Meta aprova  →  Claude: webhook + smoke test completo
ANTES DO  → Filippe: Neon Launch + monitoramento externo
1º CLIENTE   Claude: teste de carga (§12)
```

## Lembretes de produção (não esquecer)

- `META_APP_SECRET` está com **placeholder** — webhook rejeita tudo até ser trocado (fail-closed, seguro).
- A regra "IA fora do horário" exige o **expediente configurado** em Configurações do tenant.
- O **STT de áudio** precisa de credencial OpenAI (do tenant ou global do operador).
- Health check da UI do Coolify fica **desligado** de propósito: a imagem não tem curl/wget; quem checa é o `HEALTHCHECK` do Dockerfile, feito em Node.
