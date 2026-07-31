# Go-live — o que já está pronto e o que falta

**Atualizado:** 2026-07-31.

> **O rastreamento vive no Linear.** Este documento é o mapa; cada item acionável tem
> ticket. Se algo aqui não tem ticket, ou não é acionável ainda, ou o ticket faltou —
> nesse caso, crie.

## Já está em produção e validado

| Item | Endereço / estado |
|---|---|
| Landing | `https://olumechat.com.br` — TLS, CDN, SPA fallback, `www` canônico, HTTP→HTTPS |
| Backend | `https://api.olumechat.com.br` — `/health/live` e `/health/ready` em 200 |
| Painel do operador | acessível, operador de produção criado |
| Painel do Coolify | `https://ops.olumechat.com.br` atrás do Cloudflare Access |
| Banco | Neon branch `production` · `staging` · `main` (dev local) |
| Migrações | 001→026 aplicadas no boot, 49 tabelas com RLS |
| Mídia | R2 `olume-media-prod` e `olume-media-staging` |
| Firewall | 3 camadas: UFW, `DOCKER-USER`, painel Hostinger (22/80/443 apenas) |
| SSH | só por chave, senha desabilitada, updates automáticos |
| CI | 7 checks obrigatórios na `main`, incluindo RLS contra Postgres real |
| Imagens | CI publica `sha-<commit>` no GHCR a cada push na `main` |
| Deploy | staging sobe sozinho após CI verde; produção é promovida pelo Actions, sob aprovação, com rollback por SHA |
| Captação | formulário da landing grava lead no banco, com painel no operador |

## O caminho crítico até o primeiro cliente

```
CNPJ  →  conta Meta + verificação  →  app da Meta  →  primeiro cliente
  │                                                        ↑
  └─ (semanas, fora do nosso controle)                     │
                                                           │
FIL-106 monitoramento  →  FIL-110 smoke + carga + Neon ────┘
```

O bloqueio real é o **CNPJ**. Tudo que depende dele não anda por esforço nosso — por isso
começar cedo importa mais do que fazer rápido.

Enquanto isso, o **FIL-97 destravou a venda**: o sistema suporta um app da Meta **por
cliente**, então dá para implantar usando o app do próprio cliente, sem app da plataforma.
Isso não substitui o caminho acima — quando o app da Olume existir, clientes novos entram
por Embedded Signup e os antigos migram um a um, sem big bang.

## Pendências do Filippe

### 1. CNPJ → conta Meta Business → verificação (semanas)

1. Abrir CNPJ.
2. Criar conta em `business.facebook.com` com e-mail da Olume (exige uma conta pessoal do
   Facebook de um sócio como admin).
3. Submeter **verificação da empresa**: cartão CNPJ, razão social/endereço/telefone
   idênticos, site oficial (`olumechat.com.br` serve), e-mail do domínio.
4. Criar o app em `developers.facebook.com` → produto **WhatsApp**.
5. Copiar **App ID** e **App Secret**.

### 2. Repositório de volta a privado

Já pode ser feito, e **a dependência antiga caiu de vez**: instalar um GitHub App no Coolify
**não é mais necessário para deploy nenhum**. Ele existia para o Coolify clonar o
repositório e compilar na VPS; desde que os quatro ambientes viraram aplicações do tipo
`dockerimage` (FIL-100 em staging, FIL-105 em produção), o Coolify só **puxa** imagem pronta
do GHCR e não precisa de acesso nenhum ao código. Quem constrói é a CI, e quem promove é o
workflow `Deploy produção` (FIL-101), falando com a API do Coolify — não com o repositório.

> ⚠️ **Mas agora existe uma dependência NOVA, e ela é bloqueante: no plano Free, regras
> de proteção de environment só valem em repositório PÚBLICO.** Privatizar hoje
> derrubaria, **em silêncio**, as duas coisas de que a promoção para produção depende: o
> **revisor obrigatório** do environment `production` e os **environment secrets** que o
> `deploy-producao.yml` lê. O workflow não sumiria — ele passaria a rodar sem portão, ou
> falharia sem os segredos. Nenhum dos dois é um erro fácil de ligar à causa dias depois.
>
> Antes de privatizar, uma das duas: **subir para Pro ou Team** (aí environment com
> proteção funciona em repositório privado), ou **trocar o portão de aprovação por outro
> mecanismo** e mover os segredos de volta para o nível do repositório — o que reabre a
> exposição que o FIL-101 fechou, então não é uma troca barata. Enquanto nenhuma das duas
> acontecer, **manter público é o que mantém o portão de pé**.

Ao fechar o repositório, confirme também que as imagens continuam sendo puxadas — o
`docker login` da VPS usa um PAT com `read:packages`, que precisa continuar válido. É o
único vínculo que sobrou entre o Coolify e o GitHub.

### 3. Caixa `admin@olumechat.com.br` e alias comercial

Usada no operador e na política do Cloudflare Access. **Nunca foi testado se o alias
`comercial@` entrega de verdade** — está no FIL-110, e é por onde chegam os leads da
landing.

### 4. Ambiente `production` no GitHub — ✅ **feito em 2026-07-31**

Revisor obrigatório `bronze-ff`, *admin bypass* desligado e deploy só a partir da `main`.
É o portão de aprovação inteiro do `deploy-producao.yml`, e ele está de pé: a promoção
para no *Review pending deployments* e nem admin passa sem aprovação registrada.

**Não desfaça sem querer.** Apagar o ambiente não desliga o portão de forma visível — o
GitHub o recria sozinho na primeira execução que o referenciar, **sem regra nenhuma**. Por
isso o workflow confere a configuração antes de cada promoção e recusa se o revisor
obrigatório não estiver lá.

### 5. Neon no plano Launch

PITR de 6 horas é risco alto com dado de cliente. Faz parte do FIL-110.

## Pendências técnicas — com ticket

| Ticket | O quê | Por quê agora |
|---|---|---|
| **FIL-106** | Monitoramento externo com alerta no celular | Hoje, se cair, ninguém sabe |
| **FIL-110** | Smoke completo, teste de carga, Neon Launch | Portão do primeiro cliente |
| **FIL-107** | Backup do Coolify fora da VPS | Hoje o backup mora no que ele protege |
| **FIL-104** | Cores semânticas para superfície escura | Acessibilidade e consistência |
| **FIL-108** | `concurrency` na CI | Queima minutos e confunde diagnóstico |
| **FIL-109** | Dados fictícios no app autenticado | Consistência com a regra da landing |
| **FIL-103** | Junction das skills nas worktrees | Agente perde skills do repo |

## Quando a Meta chegar

- Trocar o placeholder do `META_APP_SECRET` (hoje o webhook rejeita tudo, que é o
  comportamento seguro).
- Configurar o webhook e validar assinatura.
- Fechar os itens do smoke que dependem de WhatsApp real.
- Embedded Signup, para clientes novos entrarem sem app próprio.

## Lembretes de produção (não esquecer)

- `META_APP_SECRET` está com **placeholder** — fail-closed, seguro.
- A regra "IA fora do horário" exige o **expediente configurado** no tenant.
- O **STT de áudio** precisa de credencial OpenAI (do tenant ou global do operador).
- Health check da UI do Coolify fica **desligado** de propósito: a imagem não tem
  curl/wget; quem checa é o `HEALTHCHECK` do Dockerfile, feito em Node.
- **Remover o domínio de uma aplicação não tira o container do roteamento.** Os labels do
  Traefik são gravados na criação; é preciso `docker stop`. Ver `AMBIENTES.md`.
