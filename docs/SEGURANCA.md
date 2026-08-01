# SEGURANÇA — padrão do Olume

Este bloco é obrigatório em todo ticket, PR e worker deste projeto. Foi
derivado de (a) uma auditoria real feita neste repo e (b) das 15 perguntas de
segurança do artigo "15 perguntas de segurança para quem está praticando vibe
coding" (Marcio Frayze, dev.to).

Todo PR que tocar um dos pontos abaixo deve confirmar, item a item, o que foi
verificado — ver [`WORKFLOW.md`](WORKFLOW.md) §10.

## Regras não-negociáveis (checklist do PR)

1. **Tenant só do JWT.** Nunca aceitar `tenantId` de query, header, body ou
   rota. Toda query de dado roda dentro de `comTenant()` (RLS + role
   `falatta_app`). Todo PR que toca query/pool/sessão precisa de teste
   provando que o tenant A não lê dado do B. Ver `server/auth/middleware.js`.
2. **IDOR também dentro do tenant.** Rota com `:id` valida escopo do papel
   (departamento/atendente/número) — não confia só na RLS. Ver
   `conversaNoEscopo()` em `server/api/conversas.js`.
3. **Autorização decidida no backend, sempre.** Esconder botão na UI não é
   proteção. Rota de mutação declara `exigirPapel`/guarda explícita **ou**
   restringe por escopo/dono do recurso (ex.: atalho pessoal só do criador) —
   nunca "sem checagem nenhuma porque a UI não mostra o botão". Rota nova sem
   nenhuma das duas é achado de review.
4. **Segredo nunca tem fallback fraco.** Em produção, ausência de segredo
   (JWT, storage, provedor) **falha o boot** — não cai em valor default.
   Segredo não aparece em log, resposta de API, nem mascarado.
5. **Entrada validada e SQL parametrizado.** Sempre bind, nunca concatenação.
   Input de usuário que vira SQL (nó de consulta do bot) passa por validador
   com allowlist. Export/import de CSV neutraliza fórmula (`=`, `+`, `-`, `@`)
   e tem teto de linhas.
6. **Rate limit no que custa dinheiro ou credencial.** Login, definir-senha,
   webhook público, chamadas de IA, envio à Meta, disparo de campanha,
   uploads. Limite por usuário quando o custo é por usuário, não só por IP
   (ver `limiterPorUsuario` em `server/api/conversas.js`).
7. **Uploads e mídia.** Tipo e tamanho validados; chave prefixada por tenant;
   URL assinada com expiração curta; acesso cross-tenant negado mesmo com a
   chave; path traversal bloqueado.
8. **Webhook.** Assinatura HMAC conferida com `crypto.timingSafeEqual` sobre o
   raw body; evento duplicado é idempotente; identificador desconhecido não
   cria dado órfão nem atribui tenant arbitrário.
9. **Busca não vaza nem quebra o banco.** Filtro por escopo do papel,
   paginação/limite obrigatórios, export com teto.
10. **Erro não conta segredo.** Mensagem de erro genérica para o usuário,
    detalhe no log do servidor. 401 uniforme em login (não revelar se o
    e-mail existe, se a conta está desativada, ou se foi a senha).
11. **Config de produção separada de dev.** Nada de comportamento inseguro
    decidido silenciosamente por `NODE_ENV`; fallback de desenvolvimento é
    explícito e barulhento (loga que está usando um segredo de dev).
12. **Teste de regressão para cada correção de segurança.** Sem teste, o
    próximo agente "conserta" de volta. Quando o comportamento correto é uma
    decisão de produto que parece insegura à primeira vista (ex.: a sessão de
    suporte do operador tem o mesmo CRUD que um ADMIN do tenant, sem deny de
    escrita — a proteção do cliente é a auditoria central, não um bloqueio de
    rota, ver `server/auth/middleware.js` e `server/test/operador-acesso.test.js`),
    **escreva o porquê no comentário do teste**, para ninguém reverter de
    volta por engano no futuro.

## Dados pessoais (LGPD)

O CRM guarda nome, CPF/CNPJ, e-mail, telefone e endereço de pessoas físicas.
Toda funcionalidade nova que toca esses campos precisa: escopo por papel,
registro em auditoria quando houver alteração, e nenhum vazamento em log.

## Como usar

Todo prompt de worker deste projeto deve incluir: "siga docs/SEGURANCA.md" e
o PR deve confirmar, item a item, os pontos que o ticket tocou.
