# Deploy legado — Vercel + Render + Neon + Cloudflare R2

> 🛑 **DOCUMENTO MORTO — nada aqui descreve a produção atual.** Desde 2026-07-31 o
> sistema roda em **VPS com Coolify**, consumindo imagens do GHCR, com staging
> automático e produção por promoção aprovada. A infraestrutura descrita abaixo
> (Vercel + Render) **nunca foi provisionada** e não existe.
>
> Vá para [`AMBIENTES.md`](AMBIENTES.md) — é a fonte de verdade sobre como produção
> funciona, sobe e volta.
>
> Trechos abaixo que são **ativamente falsos** hoje, e por isso este aviso é grande:
> a migração roda no **boot de cada container** (não em pre-deploy); o primeiro
> operador é criado pelo terminal do container no Coolify (não pelo Shell do Render);
> rollback é o workflow *Deploy produção* com um SHA anterior (não a UI de
> Render/Vercel); e o app da Meta **ainda não existe** — `META_APP_SECRET` é
> placeholder.
>
> Preservado só como registro do desenho anterior. Se você chegou aqui por busca de
> variável de ambiente, confira o valor em `AMBIENTES.md` antes de usar.

Este era o procedimento previsto para o primeiro deploy no desenho anterior.

Arquitetura:

```text
https://seu-dominio.com.br
└── Vercel: frontend estático Vite/React

https://api.seu-dominio.com.br
├── Render: API Express persistente
├── Render: conexão SSE
└── Render: webhook da Meta

Neon PostgreSQL: dados e LISTEN/NOTIFY
Cloudflare R2: mídia
```

O frontend chama a API diretamente. Não usamos rewrite externo da Vercel para
`/api`, porque uma conexão encaminhada pela Vercel tem timeout máximo e o SSE
precisa permanecer aberto. O backend permite CORS somente para o domínio
configurado em `APP_URL`.

Para o primeiro deploy, o Render deve permanecer com **uma instância**.
Consulte [`ESCALABILIDADE.md`](ESCALABILIDADE.md) antes de aumentar esse número.

## 1. Pré-requisitos

Tenha acesso a:

- repositório GitHub do projeto;
- conta Vercel;
- conta Render;
- projeto Neon;
- conta Cloudflare com R2;
- aplicativo em Meta for Developers;
- domínio, se já estiver disponível.

Defina duas origens:

| Serviço | Exemplo temporário | Exemplo definitivo |
|---|---|---|
| frontend | `https://olumechat.vercel.app` | `https://seu-dominio.com.br` |
| backend | `https://olumechat.onrender.com` | `https://api.seu-dominio.com.br` |

Não inclua `/api` em `APP_URL`. Inclua `/api` somente em `VITE_API_URL`.

### Preflight local

Antes de publicar o commit, execute:

```bash
cd server
npm ci
npm test
npm audit --omit=dev

cd ../client
npm ci
npm run build
npm audit --omit=dev
```

Vulnerabilidade `high` ou `critical` bloqueia o deploy. Avisos moderados devem
ser analisados conforme o uso real e registrados; não use
`npm audit fix --force` sem testar, porque ele pode trocar versões principais.

O GitHub Actions também executa os testes do servidor e o build do frontend. O
Blueprint usa `autoDeployTrigger: checksPass`, portanto o Render só publica
depois que esses checks passam.

## 2. Meta for Developers — dados iniciais

Crie ou selecione o aplicativo que será usado como plataforma:

1. abra **Configurações → Básico**;
2. copie o **ID do aplicativo** para `META_APP_ID`;
3. copie a **Chave Secreta do Aplicativo** para `META_APP_SECRET`;
4. habilite o produto WhatsApp;
5. deixe a configuração do callback para depois do deploy do Render.

O aplicativo usa credenciais de WhatsApp por tenant. Não configure
`WA_TOKEN`, `WA_PHONE_NUMBER_ID` ou `WA_BUSINESS_ACCOUNT_ID` globais em
produção.

### Versão da Graph API

O código atual foi desenvolvido com `GRAPH_VERSION=v21.0`. Use essa versão no
primeiro deploy somente enquanto ela continuar suportada pela Meta. A troca de
versão deve ser feita em um deploy separado, depois de revisar as mudanças da
Meta e testar Embedded Signup, templates, envio, mídia e webhook.

Não use simplesmente “a versão mais recente” sem homologação.

## 3. Neon PostgreSQL

Use a branch de produção do banco e obtenha duas connection strings:

| Variável | Connection string |
|---|---|
| `DATABASE_URL` | pooled; o hostname contém `-pooler` |
| `DATABASE_URL_DIRECT` | direta; hostname sem `-pooler` |
| `MIGRATION_DATABASE_URL` | a mesma conexão direta, com usuário proprietário do banco |

Todas devem usar TLS, normalmente com `?sslmode=require`.

Motivo da separação:

- a aplicação usa a conexão pooled;
- `LISTEN/NOTIFY` precisa de conexão direta;
- migrações e criação do role `falatta_app` precisam da conexão direta do
  proprietário.

Antes do deploy:

- confirme que a branch é a de produção;
- confirme que o usuário de migração pode criar tabelas, policies e roles;
- habilite backups e retenção adequados ao plano;
- não use a branch de desenvolvimento.

## 4. Cloudflare R2

1. abra **R2 Object Storage**;
2. crie um bucket privado, por exemplo `olumechat-media-prod`;
3. crie um API Token com permissão **Object Read & Write** somente nesse bucket;
4. anote:
   - nome do bucket;
   - endpoint S3;
   - Access Key ID;
   - Secret Access Key.

Valores:

| Variável | Valor |
|---|---|
| `STORAGE_DRIVER` | `s3` |
| `STORAGE_BUCKET` | nome do bucket |
| `STORAGE_REGION` | `auto` |
| `STORAGE_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `AWS_ACCESS_KEY_ID` | Access Key ID do token |
| `AWS_SECRET_ACCESS_KEY` | Secret Access Key do token |

Não use disco do Render, `MEDIA_DIR` ou bucket público para mídia de clientes.

## 5. Gerar os segredos

Execute os comandos localmente e guarde os valores em um gerenciador de
senhas. Os comandos funcionam com o Node.js já usado pelo projeto.

### `WEBHOOK_VERIFY_TOKEN`

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

### `JWT_SECRET`

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### `OPERADOR_JWT_SECRET`

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### `IA_CRYPTO_KEY`

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### `STORAGE_SIGNING_SECRET`

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Regras:

- `JWT_SECRET` e `OPERADOR_JWT_SECRET` devem ser diferentes;
- `IA_CRYPTO_KEY` deve permanecer estável: ela protege credenciais de IA e
  tokens Meta armazenados por tenant;
- trocar uma chave de criptografia sem migração torna os dados cifrados
  existentes ilegíveis;
- nunca coloque esses valores no GitHub, `vercel.json` ou em variáveis
  prefixadas com `VITE_`.

## 6. Reservar a origem do frontend

O Render precisa conhecer `APP_URL` para CORS e links de convite.

Se o domínio definitivo já estiver configurado, use-o. Caso contrário:

1. na Vercel, importe o repositório;
2. escolha **Root Directory: `client`**;
3. escolha o preset **Vite**;
4. anote a URL estável do projeto, por exemplo
   `https://olumechat.vercel.app`;
5. não é necessário testar login ainda, pois o backend ainda não existe.

Essa URL será o valor inicial de `APP_URL`.

## 7. Render — backend por Blueprint/Docker

O caminho oficial é o Blueprint da raiz do repositório. Não crie outro Web
Service manual com Root Directory `server`.

1. faça push do `render.yaml` e do `Dockerfile` atualizados;
2. no Render, selecione **New → Blueprint**;
3. conecte o repositório;
4. confirme o arquivo `render.yaml` da raiz;
5. preencha todos os valores marcados como secretos;
6. crie o Blueprint;
7. acompanhe build, pre-deploy e start nos logs.

O Blueprint já define:

- runtime Docker;
- plano Starter;
- uma instância;
- porta `10000`;
- migração no `preDeployCommand`;
- health check em `/health/ready`;
- deploy automático somente depois dos checks do GitHub passarem.

A migração roda **somente** no pre-deploy. Ela não roda novamente no startup de
cada container.

### Variáveis obrigatórias no Render

| Variável | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `10000` |
| `DATABASE_URL` | Neon pooled |
| `DATABASE_URL_DIRECT` | Neon direta |
| `MIGRATION_DATABASE_URL` | Neon direta do proprietário |
| `META_APP_ID` | ID do aplicativo Meta |
| `META_APP_SECRET` | App Secret da Meta |
| `GRAPH_VERSION` | `v21.0`, enquanto suportada e homologada |
| `WEBHOOK_VERIFY_TOKEN` | segredo de 16 bytes gerado anteriormente |
| `JWT_SECRET` | segredo de 48 bytes |
| `OPERADOR_JWT_SECRET` | outro segredo de 48 bytes |
| `IA_CRYPTO_KEY` | segredo estável de 32 bytes |
| `APP_URL` | origem exata do frontend, sem barra final e sem `/api` |
| `STORAGE_DRIVER` | `s3` |
| `STORAGE_BUCKET` | bucket do R2 |
| `STORAGE_REGION` | `auto` |
| `STORAGE_ENDPOINT` | endpoint S3 do R2 |
| `AWS_ACCESS_KEY_ID` | credencial do R2 |
| `AWS_SECRET_ACCESS_KEY` | credencial do R2 |
| `STORAGE_SIGNING_SECRET` | segredo de 32 bytes |

### Variável opcional de CORS

`CORS_ORIGINS` aceita origens adicionais exatas separadas por vírgula:

```text
https://www.seu-dominio.com.br,https://preview-estavel.vercel.app
```

Não use `*`. Não adicione previews descartáveis indiscriminadamente. O valor de
`APP_URL` já é permitido automaticamente.

### Outras variáveis opcionais

| Variável | Default | Uso |
|---|---:|---|
| `JWT_EXPIRES_IN` | `8h` | sessão do tenant |
| `OPERADOR_JWT_EXPIRES_IN` | `2h` | sessão do operador |
| `OPERADOR_SUPORTE_TTL_MIN` | `30` | sessão de suporte |
| `SENHA_TOKEN_TTL_MIN` | `4320` | convite de primeiro acesso |
| `DB_POOL_MAX` | `10` | conexões pooled por instância |
| `GRAPH_TIMEOUT_MS` | `30000` | timeout da Meta |
| `WEBHOOK_VERIFY_RATE_LIMIT_MAX` | `30` | verificação pública do webhook |
| `ENVIO_RATE_LIMIT_MAX` | `60` | envio por usuário |
| `IA_TESTAR_RATE_LIMIT_MAX` | `30` | testes de IA |
| `IA_EXTRAIR_RATE_LIMIT_MAX` | `20` | extração de arquivos |
| `SUGESTAO_IA_RATE_LIMIT_MAX` | `20` | sugestões de resposta |
| `CAMPANHA_CSV_MAX_LINHAS` | `50000` | importação de campanha |
| `IA_EXTRACAO_MAX_LINHAS` | `10000` | extração por IA |
| `CONSUMO_RETENCAO_DIAS` | `90` | retenção de consumo |
| `FATURA_DIAS_ATRASO` | `5` | regra de atraso |

Não defina `DB_SKIP_HEALTHCHECK=1` em produção.

### Verificação do backend

Após o deploy:

```text
GET https://<serviço>.onrender.com/health/live
GET https://<serviço>.onrender.com/health/ready
```

Os dois devem responder `200`. O segundo deve informar `database: "ok"`.

Anote a URL do Render. Ela será usada primeiro em `VITE_API_URL` e no callback
da Meta. Depois, pode ser substituída por um domínio customizado.

## 8. Criar o primeiro operador

Abra o Shell do serviço no Render. O script exige e-mail e senha.

Para não colocar a senha no histórico do shell:

```sh
printf "Senha do operador: "
stty -echo
read OPERADOR_SENHA
stty echo
printf "\n"
export OPERADOR_SENHA
npm run criar-operador -- --email=operador@seu-dominio.com.br --nome="Nome do operador"
unset OPERADOR_SENHA
```

Resultado esperado:

```text
[operador] criado: #<id> operador@seu-dominio.com.br
```

Não existe endpoint público para criar operador.

## 9. Vercel — frontend

No projeto Vercel com raiz `client`:

1. confirme framework **Vite**;
2. build command: `npm run build`;
3. output directory: `dist`;
4. configure as variáveis abaixo;
5. faça um novo deploy.

| Variável | Valor |
|---|---|
| `VITE_API_URL` | `https://<serviço>.onrender.com/api` ou `https://api.seu-dominio.com.br/api` |
| `VITE_COMERCIAL_EMAIL` | e-mail que recebe solicitações comerciais |

Variáveis `VITE_*` são públicas e entram no JavaScript do navegador. Nunca
coloque segredos nelas.

O `client/vercel.json` contém somente o fallback da SPA. Não adicione novamente
o rewrite `/api/*` para o Render.

### Testar CORS

Abra o frontend pela URL que está em `APP_URL` e tente fazer login.

Se aparecer `Origem não permitida`:

1. confira a origem exata exibida no navegador;
2. corrija `APP_URL` no Render; ou
3. adicione a origem extra em `CORS_ORIGINS`;
4. redeploy o backend.

Não resolva usando `Access-Control-Allow-Origin: *`.

## 10. Domínios definitivos

Configuração recomendada:

| Domínio | Provedor |
|---|---|
| `seu-dominio.com.br` | Vercel |
| `api.seu-dominio.com.br` | Render |

Depois de validar DNS e TLS:

1. altere `APP_URL` no Render para `https://seu-dominio.com.br`;
2. altere `VITE_API_URL` na Vercel para
   `https://api.seu-dominio.com.br/api`;
3. faça redeploy dos dois serviços;
4. atualize o callback da Meta;
5. repita os testes de login e SSE.

Se `www` também servir o aplicativo sem redirecionar antes, inclua
`https://www.seu-dominio.com.br` em `CORS_ORIGINS`.

## 11. Meta — webhook

Em **WhatsApp → Configuration**:

| Campo | Valor |
|---|---|
| Callback URL | `https://api.seu-dominio.com.br/webhook` ou a URL do Render |
| Verify token | o mesmo `WEBHOOK_VERIFY_TOKEN` do Render |
| Campo assinado | `messages` |

O callback aponta diretamente para o Render, nunca para a Vercel.

Depois da verificação:

- conclua a configuração necessária do Embedded Signup;
- use o painel do operador/suporte para conectar os números dos tenants;
- não habilite `DEV_META_FALLBACK` em produção.

## 12. Smoke test obrigatório

Execute na ordem:

1. `/health/live` responde `200`;
2. `/health/ready` responde `200`;
3. landing page abre no domínio principal;
4. login do operador funciona;
5. provisionamento de tenant gera convite correto;
6. login do administrador do tenant funciona;
7. login do atendente funciona;
8. conexão SSE permanece online;
9. webhook da Meta é verificado;
10. mensagem receptiva aparece uma única vez;
11. resposta enviada chega ao WhatsApp;
12. upload e leitura de mídia usam o R2;
13. troca de tema continua após recarregar;
14. suporte do operador acessa o tenant e gera auditoria;
15. campanha de teste usa apenas destinatário controlado.

Confira os logs do Render durante todo o teste. Não faça campanha real antes de
validar deduplicação, templates, opt-out e limites da Meta.

## 13. Rollback e operação

Antes de liberar clientes:

- confirme backups do Neon;
- guarde todos os segredos fora dos provedores;
- habilite alertas de erro e indisponibilidade;
- registre a versão implantada;
- conheça o procedimento de rollback do Render e da Vercel;
- não altere migrações já aplicadas; crie uma nova migração;
- não aumente `numInstances` acima de `1` ainda.

O passo seguinte para alta disponibilidade, Redis, filas, workers e load
balancer está em [`ESCALABILIDADE.md`](ESCALABILIDADE.md).

## Checklist resumido

- [ ] aplicativo Meta criado e chaves obtidas;
- [ ] Neon produção com URLs pooled e direta;
- [ ] bucket R2 privado e token restrito;
- [ ] cinco segredos gerados e guardados;
- [ ] origem Vercel reservada;
- [ ] Blueprint do Render criado;
- [ ] pre-deploy aplicou as migrações uma única vez;
- [ ] health live e ready verdes;
- [ ] primeiro operador criado;
- [ ] `VITE_API_URL` aponta diretamente para o Render;
- [ ] `APP_URL` corresponde à origem real do frontend;
- [ ] domínios e TLS válidos;
- [ ] webhook Meta verificado;
- [ ] smoke test completo;
- [ ] uma única instância do backend.
