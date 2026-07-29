# Estudo FIL-87 — Meta Business Agent Platform como modo opcional de canal

**Data:** 2026-07-29 · **Tipo:** estudo de documentação (fase 1 do POC; teste ao vivo pendente)

## Resumo executivo

O Meta Business Agent Platform (aberto a parceiros em 01/07/2026) é **arquiteturalmente
compatível** com o Olume Chat — melhor do que o estimado no primeiro levantamento. O modelo é o
de *handover* que a Meta já usava no Messenger: o agente da Meta é o respondente primário, mas
**o app do integrador recebe cópia de tudo via webhook `standby`** e pode assumir a conversa a
qualquer momento. Um futuro `numero.modo='meta_agent'` é viável sem quebrar a arquitetura.

**Recomendação: não adotar agora; manter a IA própria como produto principal e reavaliar com
um POC ao vivo em ~3 meses.** Motivos no fim; nenhum bloqueio é técnico — são de negócio
(margem, verticais, maturidade).

## Como funciona (docs oficiais)

- **Quem responde:** o agente da Meta é o *primary responder*. Enquanto ele controla a thread,
  as mensagens do cliente chegam ao integrador no campo de webhook **`standby`** (cópia); as
  respostas do agente e recibos também chegam — o app fica sincronizado. Quando o app controla,
  chegam em **`messages`** (fluxo atual do Olume Chat).
- **Takeover:** o app **assume enviando uma mensagem** (o controle vem junto) e **devolve** com
  a Thread Control API (ação `pass`). Campos de webhook exigidos: `messages`, `standby`,
  `messaging_handovers`.
- **Configuração por número** (API, com paralelos exatos ao que o Olume Chat construiu):
  *Skills* (instruções de sistema) ≈ nossas instruções; *Business info* ≈ nossa ficha;
  *FAQs/Files/Websites* ≈ nossa base de conhecimento (com upload e crawling); *Connectors* ≈
  nossas operações nomeadas (o agente chama APIs do integrador); *Settings* (persona, idioma,
  política de handoff e follow-up); *Allowlist* ≈ nosso modo teste.
- **Onboarding (tech provider):** WABA + app com `whatsapp_business_messaging`; aceitar os
  **Tech Provider Terms** no portal (chamadas são rejeitadas sem isso); system user/BISU token;
  `POST /{WABA_ID}/subscribed_apps`; ativação por número elegível na WhatsApp Manager.
- **Elegibilidade:** país e vertical suportados — 182 países; verticais: automotivo, CPG,
  serviços profissionais, varejo/e-commerce, viagens. A vertical é da conta do cliente.
- **Preço:** cobrança **por token, na WABA**, a partir de 01/08/2026 — **US$ 2,00/milhão**;
  mensagem típica ≈ 20-25k tokens ⇒ **~US$ 0,04-0,05 por mensagem** (fontes de mercado; a
  página oficial de pricing confirma o modelo e a data, não o número exato por mensagem).

## Respostas às perguntas do ticket

| Pergunta do POC | Resposta | Fonte |
|---|---|---|
| O que chega ao nosso webhook enquanto o agente atende? | **Tudo, via `standby`** — mensagens do cliente, respostas do agente e recibos. Timeline e auditoria são possíveis. | docs get-started |
| Conseguimos assumir do painel e devolver? | **Sim** — assumir = enviar mensagem (controle vem junto); devolver = Thread Control `pass`. Encaixa no Assumir/Devolver da FIL-84. | docs get-started |
| Onboarding como tech provider | Possível e documentado (BISU token + Tech Provider Terms). Fricção: ativação por número na WhatsApp Manager e elegibilidade por vertical do cliente. | docs get-started |
| Custo real vs. IA própria | ~US$ 0,04-0,05/msg. Comparável a rodar modelo classe Sonnet na nossa IA; ~10x mais caro que classe mini/Haiku. **Sem margem nossa: cobrado direto na WABA do cliente.** | pricing (mercado + oficial) |
| Qualidade (português, áudio, alucinação com a base) | **Só o teste ao vivo responde.** Áudio nativo é provável (Meta AI processa áudio no consumidor) mas não documentado para o Business Agent. | pendente |

## O que um modo `meta_agent` exigiria no Olume Chat (esboço, sem compromisso)

1. Assinar `standby` e `messaging_handovers` no webhook e persistir as cópias na `mensagem`
   (com `origem='ia'` — infra da FIL-84 serve inteira).
2. `numero.modo='meta_agent'`: conversa nasce num `fila_status` próprio; Assumir já funciona
   (enviar mensagem toma o controle); Devolver chama Thread Control.
3. Espelhar instruções/ficha/base do tenant nas APIs de Skills/Business info/Knowledge da Meta
   (sincronização — nosso painel continua sendo a fonte).
4. Consumo: não passa pelo nosso medidor — vira repasse direto Meta→cliente. Exigiria repensar
   o modelo comercial do add-on para esses números.

## Por que ainda não

1. **Margem e cobrança** — o token é cobrado na WABA, fora do nosso medidor/teto; o add-on de
   IA do Olume Chat perde o controle de custo e a margem nesses números.
2. **Verticais** — clientes fora das 5 verticais ficam de fora; nossa IA atende qualquer um.
3. **Maturidade** — a plataforma tem semanas; docs boas no fluxo principal, mas sem detalhes de
   limites, SLA, idiomas e áudio. Primeiro reajuste de preço já marcado (01/10/2026).
4. **Diferenciação** — instruções/base/ações espelhadas na Meta tornam o produto substituível;
   a IA própria (com pedidos por template, roteamento na nossa fila e medidor) é o diferencial.

## POC ao vivo (fase 2 — quando decidirmos gastar um número de teste)

- [ ] Aceitar Tech Provider Terms no app de dev; ativar o agente num número de teste da WABA
- [ ] Confirmar: cópias no `standby` chegam com payload completo? latência?
- [ ] Assumir/devolver de verdade a partir do painel; medir corrida
- [ ] Português e áudio (nota de voz) na prática; alucinação com base pequena
- [ ] Fatura real de uma semana de conversa vs. mesma carga na nossa IA

## Fontes

- https://developers.facebook.com/documentation/meta-business-agent/overview
- https://developers.facebook.com/documentation/meta-business-agent/get-started
- https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- https://techcrunch.com/2026/06/03/metas-ai-agent-for-whatsapp-business-is-now-available-globally/
- Estimativas de custo por mensagem: techtimes.com, zernio.com (não oficiais)
