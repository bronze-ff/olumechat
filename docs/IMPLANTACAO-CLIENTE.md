# Implantação de cliente — checklist reutilizável

Duas partes: o que o CLIENTE fornece/faz (seção 1 — texto pronto para enviar) e o que o
OPERADOR Olume executa (seção 2). A ordem importa: a verificação da Meta é o caminho
crítico (horas a dias) — dispare-a primeiro.

---

## 1. O que pedir ao cliente (texto pronto para enviar)

### Bloco A — Empresa e equipe (5 min para responder)

1. **Nome da empresa** como deve aparecer para os clientes finais.
2. **Identificador curto** desejado para o acesso (ex.: `minhaempresa` — sem espaços/acentos).
3. **Administrador do painel**: nome completo e e-mail (recebe o convite de primeiro acesso).
4. **Departamentos** de atendimento (ex.: Vendas, Suporte, Financeiro) — pode começar com um.
5. **Atendentes**: nome + e-mail + departamento de cada um (dá para adicionar depois).
6. **Horário de atendimento** (dias e horas) e a **mensagem fora de horário** desejada.

### Bloco B — WhatsApp oficial (o mais importante — começar já)

7. **Um número de telefone dedicado** para o WhatsApp oficial:
   - precisa receber **SMS ou ligação** na verificação (chip ativo ou fixo que atende);
   - **NÃO pode estar em uso no WhatsApp comum ou WhatsApp Business do celular** — se
     estiver, a conta WhatsApp daquele número precisa ser excluída antes (Configurações →
     Conta → Apagar conta). Recomendação: usar um número novo ou o fixo da empresa;
   - o número do dia a dia da empresa NÃO é apagado — só o que for dedicado ao canal.
8. **Conta Meta Business** (business.facebook.com) criada com e-mail da empresa. Se não
   tiver, criamos juntos na call de implantação — basta ter um e-mail corporativo e uma
   conta pessoal do Facebook de um sócio/responsável para ser o admin.
9. **Documentos para a verificação da empresa na Meta** (é o que mais demora — enviar logo):
   - CNPJ (cartão CNPJ atualizado);
   - razão social, endereço e telefone EXATAMENTE como no CNPJ;
   - site ou página oficial da empresa (ou rede social ativa);
   - e-mail com o domínio da empresa (ex.: contato@suaempresa.com.br), se houver.
10. **Uma call de ~45 min** com quem for admin da conta Meta, para conectar o número ao
    sistema com a gente guiando (processo oficial da Meta, feito uma única vez).

### Bloco C — Conteúdo do atendimento

11. Se for usar **menu automático** (ex.: "1-Vendas, 2-Suporte"): as opções e os textos.
12. **Template de primeiro contato** (mensagem ativa que a empresa manda primeiro — a Meta
    precisa aprovar o texto): ex. confirmação de pedido, aviso de vencimento.
13. Se contratou o **Agente de IA**:
    - descrição do negócio em texto livre: o que vende/faz, tom de atendimento, o que a IA
      pode e não pode prometer;
    - ficha: endereço, horários, formas de pagamento, site, área de entrega;
    - materiais da base de conhecimento: cardápio/catálogo/tabela de preços/políticas — em
      PDF com texto, planilha (XLSX/CSV) ou texto corrido;
    - **2 ou 3 telefones da equipe** para o período de teste (a IA responde só para eles
      até vocês aprovarem);
    - quando a IA deve **transferir para humano** e para qual departamento;
    - se for registrar **pedidos/agendamentos**: os campos que o pedido precisa (ex.:
      sabor, tamanho, endereço de entrega · ou · data, hora, convênio).

### Bloco D — Comercial

14. Dados de faturamento: razão social, CNPJ, e-mail do financeiro, plano contratado.

---

## 2. Roteiro interno do operador (ordem de execução)

| # | Ação | Onde | Depende de |
|---|---|---|---|
| 1 | Provisionar tenant (identificador + admin) e enviar convite | Operador → Novo cliente | A1-A3 |
| 2 | Registrar contrato/plano | Operador → Contratos | D14 |
| 3 | Abrir checklist de onboarding Meta e acompanhar cada etapa | Operador → Onboarding Meta | — |
| 4 | Cliente cria conta Business + submete verificação (docs do B9) | business.facebook.com | B8-B9 |
| 5 | Call de implantação: Embedded Signup (conecta WABA + número) | Sessão de suporte → Onboarding | B7-B10, verificação aprovada |
| 6 | Testar webhook ponta a ponta (mensagem real ida/volta) | Checklist etapa final | 5 |
| 7 | Configurar departamentos, atendentes, expediente, fora-de-horário | Sessão de suporte → Admin | A4-A6 |
| 8 | Submeter templates iniciais para aprovação da Meta | Admin → Templates | C12 |
| 9 | Se IA: preencher instruções/ficha/base (upload dos materiais), ligar modo teste com os telefones do C13, configurar regra de transferência e template de pedido | Admin → Agente de IA + Canais | C13 |
| 10 | Piloto: equipe do cliente testa (IA em modo teste; atendimento real nos números) | — | 7-9 |
| 11 | Virada: desligar modo teste da IA / ativar regra de horário; acompanhar 1ª semana | Admin → Canais | aprovação do cliente |

**Caminho crítico:** B9 (verificação Meta) — dispare no dia 0. Tudo do bloco A/C/D pode
chegar em paralelo. Sem verificação aprovada, a etapa 5 não acontece.

**Lembretes de produção:** regra "IA fora do horário" exige expediente configurado (etapa
7); STT de áudio exige credencial OpenAI ativa (global do operador ou do tenant).
