# Harness de carga (FIL-110)

Mede **onde o Olume Chat quebra** — não confirma que aguenta. Node puro, sem
dependência nova: o mesmo arquivo roda no laptop e dentro do container do
ambiente alvo.

## Duas guardas, porque são dois caminhos diferentes

> **1. Alvo HTTP.** `api.olumechat.com.br` e `olumechat.com.br` estão numa lista
> de bloqueio em [`alvo.js`](alvo.js) e não há flag que libere. Host fora da
> lista conhecida exige `--eu-sei-o-que-estou-fazendo`.
>
> **2. Banco.** `semear` cria usuários **ADMIN** e `limpar` apaga linhas — os
> dois falam direto com `DATABASE_URL` e **não** passam pela guarda de host. Por
> isso [`bancoAlvo.js`](bancoAlvo.js) exige confirmação positiva de que o banco é
> laboratório, sem default permissivo:
>
> ```bash
> CARGA_LAB=1 node scripts/carga/executar.js semear …
> # ou --eu-sei-o-que-estou-fazendo
> ```
>
> Hosts que nunca podem receber carga entram em `CARGA_BANCOS_PROIBIDOS`
> (lista separada por vírgula, comparada por **igualdade** de host).

## Testes do harness

```bash
node --test scripts/carga/*.test.js
```

Cobrem a guarda de banco e a tradução de resultado em código de saída. **Não
rodam no job `server-test` da CI**, que executa só `server/test/` — o harness
não é código de produto.

## Cenários

| Cenário | O que mede | Ponto de quebra declarado quando |
|---|---|---|
| `sse` | conexões SSE simultâneas, latência de conexão e de entrega de evento | >5% de conexões recusadas, p95 de entrega >2 s, ou >1% de eventos não entregues em 5 s |
| `pool` | fila do pool do Postgres sob concorrência | >1% de respostas não-200 ou p95 >5 s |
| `webhook` | rajada na entrada durável da Meta (ACK antes do processamento) | qualquer 503, erro de transporte, ou ACK p95 >250 ms |
| `isolamento` | um tenant não recebe evento nem enxerga conversa de outro, sob carga | qualquer vazamento |
| `semear` / `limpar` | cria e remove os tenants sintéticos | — |

## Uso

```bash
export CARGA_LAB=1   # semear/limpar recusam sem esta confirmação

# 1) dado sintético (fala DIRETO com o banco de server/.env)
#    UM usuário por conexão: semeie tenants × usuários >= o maior degrau
node scripts/carga/executar.js semear --tenants 20 --usuarios 340

# 2) medições (falam HTTP com --base-url)
node scripts/carga/executar.js pool  --base-url http://localhost:3001 --pid 12345
node scripts/carga/executar.js sse   --base-url http://localhost:3001 --pid 12345 \
  --token-local --degraus 50,100,200,400 --taxa-abertura 25
node scripts/carga/executar.js tudo  --base-url http://localhost:3001 --pid 12345

# 3) limpeza (obrigatória em ambiente compartilhado)
node scripts/carga/executar.js limpar
```

`--pid` é o PID do processo alvo; sem ele, CPU e RAM saem como "não medido" —
lacuna declarada vale mais que número inventado. Local é o PID do `node app.js`;
em staging, rode o harness de dentro do container (`docker exec`) com `--pid 1`.

### Uma identidade por conexão — e por quê

`carregarPerfil()` tem cache por (tenant, matrícula) com TTL de 30 s. Reusar
usuário faz a maioria das aberturas **pular a consulta de perfil**, e o número
medido vira o de uma reconexão com cache quente — que não existe num restart
real, onde todo atendente volta frio. Por isso:

- o cenário `sse` **recusa** rodar com identidade insuficiente, dizendo quantas
  faltam e o comando para semear;
- `--deslocamento <n>` escolhe outra janela de usuários, para que execuções
  seguidas não herdem o cache da anterior — obrigatório ao comparar taxas;
- `--reusar-identidades` libera o reuso **só** para medir entrega (o cenário
  `--um-tenant`), e marca o resultado com `identidadesReusadas` para que os
  tempos de conexão dele não sejam lidos como taxa de reconexão.

### Código de saída

`0` sucesso (inclusive com ponto de quebra encontrado — é o objetivo), `2`
recusa de guarda ou erro, `3` vazamento entre tenants, `4` isolamento
inconclusivo. Quebra é resultado; vazamento é falha.

### Staging

Staging inteiro está atrás do **Cloudflare Access**. O service token de hoje
cobre **só `/health`** (aplicação `api-staging-health`, criada para o smoke de
deploy), então `--base-url https://api-staging.olumechat.com.br` mede o
Cloudflare, não o Olume: `/api/*` responde `302` para a tela de login.

Dois caminhos, nessa ordem de preferência:

1. **De dentro da VPS** — `docker exec` no container `backend-staging-img` e
   `--base-url http://localhost:10000`. Não passa pela borda, não consome o
   Access e não disputa CPU com o Traefik. É como os números abaixo devem ser
   colhidos.
2. **Pela borda**, se e somente se a política do Access for estendida — exporte
   `CF_ACCESS_CLIENT_ID` e `CF_ACCESS_CLIENT_SECRET` no ambiente (nunca em
   arquivo). Estender a política é decisão de segurança, não de teste.

O harness diz em voz alta quando apanha `302`/`403` do Access em vez de
contabilizar a tela de login como resposta do servidor.

> ⚠️ **Staging não representa produção sob carga.** `DB_POOL_MAX` é **5** lá e
> **10** em produção, e o pool é o gargalo de tudo (`docs/CARGA-2026-08.md` §8.4)
> — o ponto de quebra medido em staging sai por volta da metade do real. Além
> disso, nenhum container tem teto de CPU/RAM: a carga disputa CPU com a produção
> na mesma VPS. Rode com essas duas ressalvas em mente, e registre as duas ao
> relatar o número.

## Arquivos que não vão para o git

- `.semente.json` — credenciais dos usuários sintéticos;
- `resultados/` — saída bruta de cada execução.

## Limpeza

`limpar` apaga, pelo prefixo `carga-fil110`, todas as linhas de **toda tabela
que tenha `tenant_id`** (descobertas no `information_schema`, em passes
sucessivos até não sobrar violação de FK) e os próprios tenants; depois remove
os `webhook_evento` sintéticos pelo marcador `CARGA-FIL110`. Lista fixa de
tabela apodrece com a próxima migração — por isso a descoberta é dinâmica.

## O que este harness NÃO faz

- Não altera o produto para se instrumentar. Sem rota de métrica nova, sem
  contador exportado só para o teste. Onde falta instrumentação, o relatório diz
  que falta.
- Não contorna a assinatura HMAC do webhook. Sem `CARGA_META_APP_SECRET` ele
  mede o caminho de rejeição e registra isso como resultado.
- Não mede latência com relógio do servidor: a entrega de evento é cronometrada
  ponta a ponta, do envio do gatilho até a chegada em cada conexão.
