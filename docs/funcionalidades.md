# Funcionalidades

O que o Olume Chat faz, pela tela. O código das rotas está em `client/src/App.jsx` e nas abas de `client/src/pages/admin/Admin.jsx`.

## Público

| Rota | O que a pessoa faz |
|---|---|
| `/` | Landing. Apresenta o produto e envia um pedido de demonstração (lead) para o comercial. |
| `/login` | Entra no painel da empresa com o slug da empresa, e-mail e senha. |
| `/definir-senha` | Define a senha do primeiro acesso, pelo link que o operador repassa. |

A landing não identifica ninguém em telemetria. PostHog só passa a valer depois do login.

## Painel da empresa (quem atende)

Sessão própria (`token`). Papéis: ADMIN, SUPERVISOR, ATENDENTE e AUDITOR.

| Rota | O que faz |
|---|---|
| `/conversas` | Inbox em tempo real (SSE): fila, assumir, transferir, encerrar, mídia, nota interna, tag, atalho e protocolo. |
| `/admin` | Configuração e operação da empresa. As abas dependem do papel. |

Abas do admin:

- **Operação ao vivo** — filas, carga e presença.
- **Indicadores** — volume, tempo e desempenho.
- **Histórico** — atendimentos e mensagens já encerrados.
- **Campanhas** — envio em massa com janela, limite diário e comprovante de entrega. Só ADMIN.
- **Fluxos de atendimento** — menu, pergunta, validação, consulta, transferir, encerrar e ir para outro fluxo. Tem simulador e importação/exportação.
- **Agente de IA** — provedor, instruções e base de conhecimento. ADMIN edita; SUPERVISOR e AUDITOR leem.
- **Modo teste da IA** — telefones que podem falar com o agente enquanto o canal está em teste. Só ADMIN.
- **Clientes** — ficha do contato.
- **Departamentos, atendentes e canais** — filas, pessoas, papéis e números de WhatsApp.
- **Configurações** — regras gerais da operação.
- **Onboarding Meta** — só aparece numa sessão de suporte, para acompanhar a conexão assistida com a Meta.

O webhook da Meta não tem tela: chega em `/webhook` (app da plataforma) ou `/webhook/<32 hex>` (app da própria empresa). A mensagem é gravada antes do ACK.

## Painel do operador (Olume)

Sessão separada (`token_operador`), em `/operador`. Não é um ADMIN da empresa. Enxerga a carteira inteira.

| Rota | O que faz |
|---|---|
| `/operador/login` | Login do operador. |
| `/operador/clientes` | Carteira: suspender, reativar, renomear e abrir suporte dentro de uma empresa. |
| `/operador/novo-cliente` | Provisiona a empresa e devolve o link de convite (ainda não há e-mail automático). |
| `/operador/leads` | Pedidos vindos da landing. |
| `/operador/onboarding` | Quem está parado em qual etapa da Meta. |
| `/operador/financeiro` | MRR, a receber e margem. |
| `/operador/financeiro/cobranca` | Faturas do mês. |
| `/operador/financeiro/alertas` | Carteira que precisa de atenção. |
| `/operador/contratos` | Plano vigente de cada empresa. |
| `/operador/auditoria` | Trilha do que o operador fez. |

A sessão de suporte entra no painel da empresa com CRUD de implantação e fica registrada na auditoria que a própria empresa lê.
