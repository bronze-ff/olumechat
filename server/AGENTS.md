# server/ — mapa e regras locais

> Delta do `../AGENTS.md` (leia o raiz primeiro). `CLAUDE.md` desta pasta é só o import.

## Mapa dos módulos

| Pasta | Responsabilidade |
|---|---|
| `api/` | Rotas do painel do cliente (RBAC via `auth/rbac.js`) |
| `webhook/` | Entrada da Meta — evento bruto **persistido antes do ACK** e efeitos pós-commit em **outbox transacional** (`durabilidade.js` + `eventoStore.js` + `efeitoStore.js`, FIL-94), tenant por `phone_number_id` |
| `ia/` | Agente de IA: `runtime.js` (3 fases), `perfilStore` (prompt em camadas), `operacoes.js` (ferramentas nativas), `stt.js`, `anexos.js`, `handoff.js`, `historico.js` (janela 40 turnos) |
| `bot/` | Chatbot de fluxos determinístico |
| `fila/` | Distribuidor (least-loaded + round-robin, debounce, leader) |
| `operador/` | Painel interno: provisionamento, financeiro, sessão de suporte (`comOperador`, BYPASSRLS) |
| `db/` | `pool.js` (`comTenant`, `comSavepoint`, binds `:nome`), `migrations/` |
| `realtime/` | Hub SSE via LISTEN/NOTIFY (usa `DATABASE_URL_DIRECT`) |
| `storage/` | Mídia: driver local (dev) ou S3/R2 (`STORAGE_DRIVER=s3`) |
| `consumo/` | Medição cobrável (mensagens, tokens, STT) |

## Regras locais

- **Os cabeçalhos dos arquivos são documentação de decisões** (com nº de ticket e achados
  de review). Leia o cabeçalho antes de mexer; mantenha o padrão ao editar.
- Todo acesso a dado de tenant roda dentro de `db.comTenant(tenantId, fn)` — RLS +
  `SET LOCAL ROLE`. Caminho de operador usa `operador/db.js::comOperador` (tenant_id
  explícito em TODA query). Nunca misture os dois na mesma requisição aberta.
- Eventos de tempo real publicam **pós-commit** (padrão `posCommit`/efeitos por fase do
  `ia/runtime.js`) — nunca publique de dentro de transação que ainda pode falhar.
- Erros de envio pra Meta não podem virar silêncio pro cliente final (padrão "nunca
  silêncio" do runtime).
- **O webhook responde 200 só depois de gravar o evento** (`webhook/durabilidade.js`).
  Falha de persistência → 503 (a Meta reenvia). Nunca reintroduza "ACK e processa em
  memória": um restart perde a mensagem do cliente sem rastro.
- **Efeito pós-commit do webhook nasce no outbox, na transação do change**
  (`webhook/efeitoStore.js`). Devolver efeito só em memória volta a perder a resposta
  automática do cliente quando o processo morre entre o commit e o dispatch — e o replay
  não reproduz (o dedup por WAMID pula a mensagem). Efeito novo = mais um `tipo` tratado
  em `processEvent::despachar`, nada além disso.
- **Replay é normal aqui**: `processChange` consulta os WAMIDs já gravados ANTES de tocar
  contato/conversa/consumo. Escrita nova no caminho da mensagem entra DEPOIS desse
  pré-check, senão o reprocessamento rebobina a janela de 24h ou cobra duas vezes.
- Testes: `npm test` (suite completa, sem rede); integração real com Postgres exige
  `TEST_DATABASE_URL` (senão são pulados — e isso é ok). Rode a suite ANTES do push.
