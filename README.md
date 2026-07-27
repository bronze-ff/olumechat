# Falatta

Plataforma **multi-tenant** de atendimento por WhatsApp, integrada direto na
**WhatsApp Cloud API da Meta** (sem BSP). Inbox multi-atendente com filas,
chatbot de fluxos, bot de IA, campanhas em massa e métricas — vendida como
serviço para empresas de qualquer segmento (farmácia, RH, clínica, varejo).

> ⚠️ **Estado atual: fork em porte.** O código veio do `mc-atendimentos`, um
> sistema on-prem single-tenant que rodava em Oracle acoplado ao ERP WinThor.
> O acoplamento com o cliente original **já foi removido** (ver "O que saiu"),
> mas o porte para Postgres/Neon e a multi-tenancy **ainda não foram feitos**.
> O que fazer, em ordem, está em [`docs/PORTE.md`](docs/PORTE.md).
> **Não existe deploy ainda. Não rode isto em produção.**

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

| Camada | Hoje (herdado) | Alvo |
|---|---|---|
| Backend | Node.js 18+ · Express | igual |
| Banco | **Oracle** (node-oracledb thick) | **PostgreSQL no [Neon](https://neon.com)** (`pg`) |
| Tenancy | nenhuma (single-tenant) | **shared schema + RLS**, `tenant_id` em tudo |
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

**Ainda com resíduo** (enumerado em `docs/PORTE.md`): `auth/routes.js` loga
contra uma tabela do ERP antigo, os nomes de tabela são `MC_ZAP_*`, e
`api/contatos.js` carrega campos do cadastro de cliente do WinThor.

---

## Referência

`docs/referencia/schema-oracle/` guarda a DDL Oracle original. **Não é para
rodar** — é a fonte de verdade do modelo de dados enquanto o schema Postgres é
escrito.

## Desenvolvimento

```bash
cd server && npm install && npm test    # node:test
cd client && npm install && npm run dev
```

Convenções de branch, commit, PR e review: [`docs/WORKFLOW.md`](docs/WORKFLOW.md).
