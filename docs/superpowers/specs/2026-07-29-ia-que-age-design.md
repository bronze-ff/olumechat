# IA que age: ficha, tags e pedidos com template por empresa

**Data:** 2026-07-29
**Fatia:** 3 de 4 do roadmap de IA (FIL-85) — a última a ser implementada
**Estado:** aprovado, pronto para plano de implementação

## Problema

A IA atende, escala e escuta (fatias 1, 2 e 4 mergeadas), mas não age: não preenche a ficha
do contato, não etiqueta a conversa e não registra pedido/agendamento. O atendente que assume
recebe a conversa sem contexto estruturado, e pedido anotado em texto livre se perde.

## Escopo desta fatia

Dentro:

- Ferramentas nativas novas: `atualizar_ficha_contato`, `aplicar_tag`, `registrar_pedido`
- Habilitação por tenant (`ia_ferramenta`)
- Template de pedido configurável por empresa + tela do admin
- Tela do atendente para conferir pedidos
- Janela de histórico e concorrência do `numero_turno`

Fora:

- Integração com sistema externo do cliente (API/webhook por tenant) — decisão de roadmap
- Ferramenta separada de classificar/rotear — **rotear por departamento já existe** no
  `transferir_para_humano(departamento)` da FIL-84; ferramenta separada só confundiria o modelo
- Criação de tag nova pela IA (ela só aplica as já cadastradas)
- Múltiplos templates de pedido por empresa (v1: um) e agendamento com agenda/disponibilidade
  (é registro, não calendário)

## Decisões confirmadas

### Ferramentas (catálogo no código, `ia/operacoes.js` — nasceu na FIL-84)

- **`atualizar_ficha_contato`** — preenche **somente campos já existentes** do cadastro de
  contato (nome, documento, vínculo com cliente — o worker mapeia as colunas reais). Sem
  migração de contato, sem campo novo. Nunca sobrescreve valor já preenchido sem o dizer: a
  ferramenta devolve o que mudou e o turno registra.
- **`aplicar_tag`** — aplica tags **já cadastradas** do tenant. O schema da ferramenta lista as
  tags existentes como enum (dinâmico por tenant); tag inexistente é erro de ferramenta, não
  criação silenciosa.
- **`registrar_pedido`** — cria um registro estruturado a partir do **template do tenant**
  (abaixo). Sem template configurado, a ferramenta **não é oferecida** ao modelo, mesmo ligada.
- Toda ação da IA aparece na timeline como evento de sistema com `origem='ia'` (infra da
  FIL-84) — o atendente vê o que a IA fez, quando.

### Habilitação por tenant

Tabela `ia_ferramenta`: `tenant_id`, `nome` varchar, `ativo` char CHECK S/N,
`atualizado_em`. `UNIQUE (tenant_id, nome)`. O catálogo (schema/execução) vive no código; o
banco só liga/desliga. **Defaults:** `atualizar_ficha_contato` e `aplicar_tag` nascem
ligadas (inofensivas); `registrar_pedido` nasce desligada — só faz sentido depois que o admin
configurou o template e conheceu a tela de conferência. Toggle na tela Agente de IA.

### Template de pedido por empresa

Escolha explícita do brainstorming: **template configurável**, não estrutura fixa — pizzaria
define sabor/tamanho/entrega, clínica define data/hora/convênio.

- Tabela `ia_pedido_template`: `tenant_id` PK (um template por empresa na v1), `titulo`
  varchar(80), `campos` jsonb, `atualizado_por`, `atualizado_em`.
- `campos`: lista de `{ nome, rotulo, tipo, obrigatorio, opcoes? }` com
  `tipo ∈ { texto, numero, data, hora, opcoes }`. Máx. 20 campos; `opcoes` máx. 30 itens.
  A aplicação valida (mesmo racional do jsonb da ficha na FIL-83).
- O **schema da ferramenta é gerado do template** (a tradução por provedor já existe em
  `ia/client.js`): campo obrigatório vira parâmetro obrigatório; `opcoes` vira enum.
- Tela do admin: seção **Pedidos** na tela Agente de IA — editor de campos simples (adicionar,
  remover, reordenar, tipo, obrigatório, opções). Sem lógica condicional, sem multi-página:
  é um formulário, não um form-builder completo.
- Gatilho para reconsiderar (v2): mais de um template por empresa (ex.: pedido E agendamento).

### Registro de pedido

Tabela `ia_pedido`: `id`, `tenant_id`, `conversa_id`, `contato_id`, `payload` jsonb (chaves =
nomes dos campos do template no momento do registro), `status` CHECK
(`rascunho`,`conferido`,`descartado`) default `rascunho`, `criado_em`, `conferido_por`
(FK atendente), `conferido_em`. `UNIQUE (tenant_id, id)`, índice `(tenant_id, status)`.
O payload guarda uma cópia dos rótulos junto dos valores — template editado depois não
corrompe pedidos antigos.

### Tela do atendente

- Lista de pedidos (filtro por status, default `rascunho`) na área do atendente, com acesso
  também a partir da conversa (badge/atalho quando a conversa tem pedido rascunho).
- Ações: **conferir** (marca `conferido`, registra quem/quando) e **descartar** (com motivo
  opcional em observação). Nada é enviado a sistema externo.
- Pedido novo publica evento no bus (o badge aparece ao vivo — infra da FIL-84).

### Robustez (dívidas apontadas na issue)

- **Janela de histórico:** `historico.carregar` limita aos **últimos 40 turnos** por conversa
  (tool calls aceleram o crescimento; histórico inteiro a cada turno é custo direto).
  Turnos além da janela simplesmente não vão ao provedor.
- **Concorrência do `numero_turno`:** trocar o read-then-insert (`MAX+1`) por
  `ON CONFLICT ... retry` (ou constraint + retry curto) — as ferramentas aumentam turnos por
  mensagem.

### Transversais

- Migração `022`, tabelas novas no bloco RLS `isolamento_tenant`, idempotente de verdade.
- Schema dinâmico (tags, template) e habilitação: cache TTL 60s por tenant (padrão
  `perfilStore`), invalidado ao salvar ferramenta/template/tag.
- Rotas: leitura ADMIN/SUPERVISOR/AUDITOR; escrita de config ADMIN; conferir/descartar pedido
  é do ATENDENTE (com papel de atendimento); tudo atrás de `ia_habilitada`. Escrita audita.
- Sem consumo novo: ações não cobram além dos tokens já medidos.

## Testes

- Ferramenta desligada (ou pedido sem template) fora do schema enviado ao provedor
- Schema gerado do template: obrigatórios, enums de `opcoes`, tags do tenant
- `atualizar_ficha_contato` só toca campos permitidos; registra o que mudou
- `aplicar_tag` com tag inexistente → erro de ferramenta (nada criado)
- `registrar_pedido` valida payload contra o template; rascunho criado; evento publicado
- Conferir/descartar: status, quem/quando; papéis errados 403
- Template editado não corrompe pedido antigo (rótulos copiados)
- Janela de 40 turnos; concorrência do `numero_turno` sem duplicata sob corrida
- Isolamento multi-tenant em tudo; migração 022 idempotente + RLS

## Decisões conscientes

| Decisão | Gatilho para reconsiderar |
|---|---|
| Um template de pedido por empresa | empresa real precisando de pedido E agendamento separados |
| IA não cria tag | demanda real com controle (aprovação do admin) |
| Rotear embutido no transferir | caso real de re-rotular fila sem transferir |
| Janela fixa de 40 turnos | conversa real perdendo contexto essencial |
