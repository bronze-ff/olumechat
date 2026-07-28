# Instruções e base de conhecimento da IA, por empresa

**Data:** 2026-07-28
**Fatia:** 1 de 4 do roadmap de IA
**Estado:** aprovado, pronto para plano de implementação

## Problema

O system prompt da IA vem hoje de um arquivo em disco (`CONHECIMENTO_DIR/system-prompt.md`),
global para o processo inteiro. A pasta não existe no repositório, então na prática **todas as
empresas rodam com o fallback embutido**, que diz "Você é o assistente da Multicanal Atacado no
WhatsApp". É resquício do fork e contradiz o PRODUCT.md, que proíbe preservar o vocabulário da
Multicanal.

Além disso o cliente não tem onde descrever o próprio negócio. Sem isso a IA não tem o que
responder, e nenhuma das fatias seguintes do roadmap de IA faz sentido.

## Escopo desta fatia

Dentro:

- Tabelas `ia_perfil` e `ia_conhecimento`
- Montagem do system prompt em camadas, por empresa, com cache
- Tela de configuração: instruções, ficha da empresa, blocos de conhecimento, medidor de espaço
- Caixa de teste (pergunta → resposta com a configuração salva)
- Remoção do prompt em disco e do vocabulário Multicanal do caminho da IA

Fora (fatias seguintes):

- Ativação da IA por canal com regra de horário — fatia 2
- Handoff IA ↔ humano nos dois sentidos — fatia 2
- Ferramentas/ações da IA (classificar, rotear, preencher ficha, registrar pedido) — fatia 3
- Upload de arquivo (PDF/planilha) na base — fatia 4

## Modelo de dados

### `ia_perfil` — uma linha por empresa

| coluna | tipo | nota |
|---|---|---|
| `tenant_id` | bigint PK | `DEFAULT tenant_atual()`, FK `tenant` |
| `instrucoes` | text | persona e regras do negócio |
| `ficha` | jsonb NOT NULL DEFAULT `'{}'` | dados fixos da empresa |
| `atualizado_por` | bigint | FK composta `atendente (tenant_id, id)` |
| `atualizado_em` | timestamptz NOT NULL DEFAULT now() | |

`ficha` guarda chaves conhecidas pela aplicação: `endereco`, `telefones`, `horario`,
`pagamento`, `site`, `observacoes`.

**Por que jsonb e não colunas fixas:** a ficha vai crescer (área de entrega, redes sociais).
Como `scripts/migrar.js` re-executa o histórico inteiro a cada deploy, cada campo novo viraria
uma migração a mais no caminho crítico do boot. Um campo flexível evita isso, e a aplicação
valida as chaves.

### `ia_conhecimento` — N linhas por empresa

| coluna | tipo | nota |
|---|---|---|
| `id` | bigint identity PK | |
| `tenant_id` | bigint | `DEFAULT tenant_atual()`, FK `tenant` |
| `titulo` | varchar(120) NOT NULL | ex.: "Cardápio", "Política de troca" |
| `conteudo` | text NOT NULL | |
| `ativo` | char(1) NOT NULL DEFAULT `'S'` | CHECK `('S','N')` |
| `ordem` | integer NOT NULL DEFAULT 0 | ordem no prompt |
| `atualizado_em` | timestamptz NOT NULL DEFAULT now() | |

`UNIQUE (tenant_id, id)` (convenção do schema, permite FK composta depois).
`INDEX (tenant_id, ativo, ordem)`.

Ligar/desligar em vez de apagar atende o caso real de cardápio sazonal e promoção encerrada.

### Restrições transversais

- **Ambas as tabelas entram no bloco de RLS** (`isolamento_tenant`, migração 001). Tabela nova
  fora desse bloco fica sem isolamento entre empresas, silenciosamente.
- **A migração precisa ser idempotente de verdade**, não só "não dá erro ao repetir" —
  `migrar.js` re-aplica todo o histórico a cada deploy.
- Sem backfill: ninguém em produção ainda.

### Limites

- Instruções: 8.000 caracteres
- Bloco: 20.000 caracteres cada
- Máximo 50 blocos por empresa

Escolhidos para caber com folga no orçamento de contexto e para dar erro claro na API em vez de
estourar no provedor.

## Montagem do prompt

Módulo novo `server/ia/perfilStore.js`:

- `carregar(conn, tenantId)` → `{ instrucoes, ficha, blocos }`. Cache `Map`, TTL 60s, chaveado
  por tenant — mesmo padrão do `iaConfigStore`.
- `invalidar(tenantId)`
- `montarSistema(perfil)` → string do system prompt

**Recebe `conn`**, diferente do `iaConfigStore` (que não recebe porque precisa de `comOperador`
para a credencial global). O conteúdo aqui é 100% do tenant, então roda dentro da transação que
o runtime já tem aberta na fase 3 — evita que uma requisição segure duas conexões do pool, que é
justamente o motivo do runtime estar dividido em três fases.

Camadas, nesta ordem:

1. **Base do sistema** — constante no código, não editável
2. **Instruções do admin**
3. **Ficha renderizada** em linhas rotuladas
4. **Blocos ativos**, por `ordem`
5. **Data/hora de Brasília** — já existe hoje

A camada 1 contém: responder em português; usar apenas as informações fornecidas; quando não
souber, dizer que vai verificar em vez de inventar; não prometer prazo, preço ou condição que
não esteja escrito; nunca pedir senha, cartão ou dado bancário.

**Por que a camada 1 é intocável:** um admin que escreve instruções ruins não pode remover o
"não invente". É o piso anti-alucinação — a diferença entre um produto e um passivo para o
cliente.

Empresa sem perfil configurado recebe só a camada 1 mais uma linha neutra ("assistente de
atendimento desta empresa"). Nunca o texto da Multicanal.

## Mudanças no runtime

`server/ia/runtime.js`:

- `carregarSistema()` e `SISTEMA_FALLBACK` saem — some o `readFileSync` a cada mensagem
- `montarSistema` passa a ser chamado com o `conn` da fase 3
- A mensagem de telefone não autorizado deixa de citar a Multicanal (hoje: *"Fale com a TI da
  Multicanal para liberar seu acesso"* — texto que chega ao cliente final de qualquer empresa)

## API

| rota | papel | nota |
|---|---|---|
| `GET /api/ia-perfil` | ADMIN, SUPERVISOR, AUDITOR | perfil + blocos + total do medidor |
| `PUT /api/ia-perfil` | ADMIN | instruções + ficha |
| `POST /api/ia-conhecimento` | ADMIN | |
| `PUT /api/ia-conhecimento/:id` | ADMIN | |
| `DELETE /api/ia-conhecimento/:id` | ADMIN | remoção real — nada referencia o bloco |
| `POST /api/ia-perfil/testar` | ADMIN | `{ pergunta }` → `{ resposta }` |

Todas exigem `tenant.ia_habilitada = 'S'` (o add-on de IA). Toda escrita audita e invalida o
cache.

`POST /testar` chama o provedor com `semFerramentas: true`, **registra consumo**
(`registrarIaTokens`) e respeita o teto mensal. Sem isso vira caminho para gastar token sem
aparecer no consumo do cliente.

**Não usar a tabela `config` para isso:** `GET /api/config` devolve tudo para qualquer usuário
autenticado, sem filtro por papel — um atendente comum leria as instruções da IA. E o `PUT`
trunca valores em 2.000 caracteres, o que mataria um cardápio.

## Tela

Aba "Agente de IA" (`client/src/pages/admin/IaConfig.jsx`), seções em sequência:

1. Provedor — existente, somente leitura
2. **Instruções** — textarea, contador, placeholder com exemplo real
3. **Ficha da empresa** — campos
4. **Base de conhecimento** — blocos expansíveis: adicionar, editar, ativar/desativar,
   reordenar, remover
5. **Medidor de espaço**
6. **Testar** — pergunta + resposta
7. Recursos — existente (sugestão de resposta)

**Uma tela só, não abas separadas:** configurar isso é uma tarefa única, feita uma vez, por
alguém que acabou de contratar. Espalhar em três lugares piora exatamente o primeiro uso.

### Medidor

Mostra total em caracteres, estimativa de tokens por mensagem e faixa de cor:
verde até 10.000 caracteres, amarelo até 25.000, vermelho acima.

O texto de apoio explica a consequência real: já existe teto mensal de tokens por empresa
(`tenant.ia_teto_tokens_mes` + `ia_consumo_mensal`), e a base inteira vai no prompt a **cada**
mensagem trocada. Base inchada não deixa só lento — queima o teto mais rápido. O medidor é
controle de custo, não enfeite.

### Estado vazio

Ensina o que escrever: exemplo de instrução, e sugestões de bloco por tipo de negócio.

## Permissões

- Ver: ADMIN, SUPERVISOR, AUDITOR
- Editar: ADMIN
- Tudo atrás de `iaHabilitada`
- A sessão de suporte do operador entra como AUDITOR → lê, não escreve. Deliberado: quando o
  cliente reclamar "a IA respondeu errado", o suporte precisa ver as instruções que causaram
  aquilo.

## Testes

- **Montagem:** camadas na ordem certa; bloco inativo fica de fora; empresa sem perfil não
  quebra e **não** recebe o texto da Multicanal
- **Isolamento:** perfil de um tenant nunca aparece no prompt de outro
- **Cache:** invalida ao salvar
- **Rotas:** papel errado → 403; add-on desligado → 400; limites de tamanho → 400
- **Teste:** consumo registrado; teto mensal respeitado
- **Runtime:** prompt montado do banco, não de disco

## Decisões conscientes

| Decisão | Gatilho para reconsiderar |
|---|---|
| Sem RAG — tudo no contexto, com medidor | Um cliente real estourar a faixa vermelha |
| Sem versionamento das instruções (a auditoria guarda quem/quando, não o conteúdo anterior) | Alguém precisar reverter uma mudança |
| Sem upload de arquivo | Fatia 4 |
| Sem ferramentas por tenant | Fatias 2 e 3 |

## Roadmap — as outras fatias

- **Fatia 2 — Atendimento por IA com handoff.** Ativação por canal com regra de horário;
  ferramenta de transferir para a fila; atendente assume com um clique e a IA cala. Hoje
  `fila_status='ia'` é definido uma única vez, na criação da conversa, a partir de `numero.modo`
  — não existe caminho projetado de saída. E o runtime da IA não publica nenhum evento de
  tempo real, então o front só descobre a resposta pelo polling de 60s.
- **Fatia 3 — IA que age.** Classificar e rotear por departamento, aplicar tags, preencher a
  ficha do contato, registrar pedido/agendamento. Precisa do registro de ferramentas por tenant
  — hoje `TOOLS = []` e o executor lê SQL do disco, sem dimensão de tenant.
- **Fatia 4 — Upload de arquivo** na base de conhecimento.
