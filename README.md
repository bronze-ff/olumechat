# Olume Chat

Plataforma **multi-tenant** de atendimento por WhatsApp, integrada direto na
**WhatsApp Cloud API da Meta** (sem BSP). Inbox multi-atendente com filas,
chatbot de fluxos, bot de IA, campanhas em massa e métricas — vendida como
serviço para empresas de qualquer segmento (farmácia, RH, clínica, varejo).

> ⚠️ **Estado atual: fork em porte.** O código veio do `mc-atendimentos`, um
> sistema on-prem single-tenant, e o acoplamento com o cliente original **já
> foi removido** (ver "O que saiu"). A **fundação Postgres/Neon já está de
> pé**: schema multi-tenant com RLS, pool `pg`, helper de binds e
> `comTenant()`. O que ainda falta é o **porte das queries dos módulos de
> negócio** (`api/*`, `bot/*`, `ia/*`, `fila/*`), que seguem escritas para o
> schema antigo — por isso o sistema **ainda não roda de ponta a ponta**.
> O que fazer, em ordem, está em [`docs/PORTE.md`](docs/PORTE.md).
> A arquitetura para Redis, filas, workers, cache, load balancer e escala
> horizontal está em
> [`docs/ESCALABILIDADE.md`](docs/ESCALABILIDADE.md).
> A configuração de deploy está em [`docs/DEPLOY.md`](docs/DEPLOY.md), mas a
> liberação para clientes depende do smoke test e da homologação descritos lá.

---

## Produto

**Dois painéis:**

- **Painel do cliente (tenant)** — a empresa que comprou faz login, opera o
  inbox, configura departamentos, atendentes, fluxos, bot de IA e campanhas.
- **Painel do operador (você)** — libera acesso a novos clientes, provisiona o
  tenant, vincula o número de WhatsApp à conta Meta do cliente e acompanha uso.
  Existe porque o cliente final **não consegue** fazer o processo da Meta
  sozinho.

**Funcionalidades herdadas (prontas, funcionando):**

- Inbox em tempo real (SSE), mídia, notas internas, tags, busca, atalhos `/`
- Multi-número por tenant; um webhook atende vários números
- Filas por departamento com distribuição automática (least-loaded + round-robin),
  presença, assumir/transferir/encerrar, protocolo por atendimento
- Acesso por número por atendente
- Chatbot de fluxos (menu, pergunta, validação, consulta, transferir, encerrar,
  ir-para-fluxo) com simulador e import/export JSON
- Bot de IA: runtime com tool-loop, histórico multi-turno, autorização por
  telefone, adaptadores Anthropic e OpenAI-compatível, chaves cifradas AES-256-GCM
- Campanhas em massa com throttle, limite diário, janela comercial, dedup de
  9º dígito e comprovante de entrega/leitura
- Dashboard de métricas, histórico pesquisável, RBAC (ADMIN/SUPERVISOR/
  ATENDENTE/AUDITOR)

---

## Stack

| Camada | Hoje | Alvo |
|---|---|---|
| Backend | Node.js 18+ · Express | igual |
| Banco | **PostgreSQL no [Neon](https://neon.com)** (`pg`) | igual |
| Tenancy | **shared schema + RLS**, `tenant_id` em tudo | igual (queries dos módulos ainda a portar) |
| Frontend | React 18 · Vite 5 · Tailwind 3 | igual |
| Auth | JWT HS256 + blacklist de `jti` | igual, com login próprio |
| Tempo real | SSE + EventEmitter **in-process** | barramento externo (ver PORTE) |
| Integração | WhatsApp Cloud API, webhook assinado | + **Embedded Signup** |
| Entrega | instalador .exe on-prem | **SaaS** em container persistente |

---

## O que saiu do fork (acoplamento com o cliente original)

| Removido | O que era |
|---|---|
| `bot/boleto.js`, `bot/boleto-pdf.js` | 2ª via de boleto via SQL do WinThor — e o nó `boleto` do engine |
| `api/clientes.js` | busca na `MCCANAL.PCCLIENT` |
| `ia/githubSync.js`, `api/conhecimento.js` | sync do conhecimento de um repo privado do cliente |
| `scripts/submeter-template-*` | submissão de templates de cobrança específicos |
| deps `bwip-js`, `pdfkit`, `bytenode`, `esbuild` | código de barras do boleto e bytecode do instalador |
| `installer/` | não foi copiado — o produto é SaaS |

**Virou ponto de extensão** (em vez de deletado):

- `utils/clienteLookup.js` — era `telefone → PCCLIENT`. Agora é um **seam**: o
  núcleo chama, e um provedor por tenant pode ser registrado com
  `registrarProvedor()`. Sem provedor, devolve `null` e o sistema segue.
- `ia/tools.js` — eram tools fixas do ERP do cliente. Agora nasce **vazio**;
  cada tenant cadastra as suas.

- `auth/routes.js` — logava contra a tabela de senhas do ERP do cliente. Agora
  é **login próprio**: tabela `usuario` por tenant, senha em argon2id, e o
  `tenant_id` viaja assinado no JWT (FIL-67).

**Ainda com resíduo** (enumerado em `docs/PORTE.md`): os nomes de tabela são
`MC_ZAP_*` em parte do código, e `api/contatos.js` carrega campos do cadastro
de cliente do WinThor.

---

## Banco de dados

Schema em `server/db/migrations/` — numerado, idempotente e **nunca editado
depois de aplicado**. Mudança de schema é migração nova.

```bash
cd server
cp .env.example .env          # preencha DATABASE_URL (string POOLED do Neon)
npm run migrar                # aplica db/migrations/ em ordem
```

Para DDL prefira a connection string **direta** (host sem `-pooler`), via
`MIGRATION_DATABASE_URL`. O barramento SSE tambÃ©m exige essa conexÃ£o direta em
`DATABASE_URL_DIRECT`, usada pela sessÃ£o dedicada de `LISTEN/NOTIFY`.

### Como falar com o banco

Toda query de dados de tenant passa por `comTenant()`. Os binds continuam
nomeados (`:nome`) como no código herdado — `server/db/sql.js` traduz para os
posicionais (`$1`) do `pg`:

```js
const { comTenant } = require('./db/pool');

const conversas = await comTenant(req.tenantId, async (conn) => {
  const r = await conn.execute(
    'SELECT id, protocolo FROM conversa WHERE fila_status = :st',
    { st: 'aguardando' }
  );
  return r.rows;               // só linhas do tenant corrente
});
```

`comTenant()` abre a transação, assume o papel de aplicação e seta o tenant com
`set_config('app.current_tenant_id', $1, true)` — **transaction-scoped**, pois
o pooler do Neon roda PgBouncer em *transaction mode* e uma configuração de
sessão vazaria o tenant para a requisição seguinte. Detalhes e a armadilha
completa no topo de [`server/db/pool.js`](server/db/pool.js); o isolamento tem
teste dedicado em `server/test/db-tenant.test.js`.

## Painel do operador

O super-admin do SaaS (nós) vive **fora** do RBAC de tenant, em `/api/operador/*`
e `/operador` no front: provisiona clientes, suspende, reativa, renomeia,
acompanha o uso e entra num tenant para dar suporte. Não é um `ADMIN` com flag —
é outra sessão, com outro segredo de JWT e middleware próprio
([`server/operador/`](server/operador/)).

```bash
cd server
npm run migrar                                   # aplica a 005_operador.sql
OPERADOR_SENHA='...' npm run criar-operador -- --email=voce@olumechat.com.br --nome="Seu Nome"
```

Não há auto-cadastro de operador: a primeira conta nasce por esse script, rodado
por quem já tem acesso ao banco.

Como este painel **enxerga todos os tenants**, ele não usa `comTenant()`: as
queries passam por `comOperador()` (contexto de tenant nulo, explícito — ver o
topo de [`server/operador/db.js`](server/operador/db.js)), e as tabelas
`operador`/`operador_auditoria` são fechadas para o role de tenant na própria
migração. Toda ação de operador gera trilha em `operador_auditoria`; o acesso de
suporte é registrado **também** na `auditoria` do cliente, que ele lê no painel
dele — e é somente-leitura, imposto no middleware de tenant (qualquer método que
não seja de leitura vira 403 para uma sessão de suporte).

Enquanto não houver envio de e-mail, o provisionamento **devolve o link do
convite na resposta da API** para o operador repassar ao cliente — decisão
provisória, registrada no PR do FIL-70.

## Referência

`docs/referencia/schema-oracle/` guarda a DDL Oracle original do fork. **Não é
para rodar** — ficou como fonte histórica do modelo de dados; o schema vigente
é o de `server/db/migrations/`.

## Desenvolvimento

```bash
cd server && npm install && npm test    # node:test
cd client && npm install && npm run dev
```

Os testes de RLS contra Postgres real só rodam com `TEST_DATABASE_URL` no
ambiente; sem ela são pulados e a suíte segue verde.

## Deploy (Vercel + Render + Neon + R2)

O frontend estático roda na Vercel e chama diretamente a API persistente no
Render. O Blueprint está em [`render.yaml`](render.yaml), usa
`/health/ready`, executa migrações no pre-deploy e mantém deliberadamente
**uma única instância**. Presença, tickets SSE e rate limits precisam ser
distribuídos antes de aumentar esse limite; o plano está em
[`docs/ESCALABILIDADE.md`](docs/ESCALABILIDADE.md).

### Subir do zero

1. Prepare Neon, R2, aplicativo Meta e os segredos.
2. Reserve a origem do frontend na Vercel.
3. No Render, crie um Blueprint a partir da raiz deste repositório e preencha
   os valores `sync: false`.
4. O `preDeployCommand` aplica as migrações uma única vez; uma falha impede a
   publicação da nova versão.
5. Configure `VITE_API_URL` na Vercel apontando diretamente para
   `https://SEU_HOST/api`.
6. Valide `https://SEU_HOST/health/live` e
   `https://SEU_HOST/health/ready`.

O procedimento completo, as variáveis e o smoke test obrigatório estão em
[`docs/DEPLOY.md`](docs/DEPLOY.md). Para desenvolvimento local, copie
`server/.env.example` para `server/.env` e use uma branch Neon descartável.

### Proteção do GitHub

No repositório `bronze-ff/olumechat`, o administrador deve proteger `main`, exigir
pull request, exigir o check `test` deste workflow e bloquear push direto. O
merge continua sendo feito manualmente após o CI verde.

Convenções de branch, commit, PR e review: [`docs/WORKFLOW.md`](docs/WORKFLOW.md).
