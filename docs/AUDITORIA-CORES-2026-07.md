# Auditoria de cores literais em `client/src` — FIL-104

Data: 2026-07-31. Escopo: FIL-104 ("Sistema de design não cobre superfície
escura — auditar app e fechar a lacuna"). Método: `grep` de `#rrggbb`/`rgb()`
em todo `client/src`, cada ocorrência lida em contexto e classificada como
**deriva** (existe token equivalente, código não usava), **lacuna real**
(combinação usada no app e não coberta por token) ou **justificada** (caso
único de verdade, documentado no próprio arquivo).

## Resultado resumido

- 126 ocorrências de cor literal em 15 arquivos.
- Nenhuma combinação semântica (`success`/`warning`/`danger`/`info`) sobre
  superfície escura **em uso real** ficou abaixo de 4,5:1 — as duas únicas em
  uso (`success-on-dark`, `danger-on-dark`) já existiam desde o PR #49 e
  medem 10,50:1 e 10,58:1 respectivamente. `warning` e `info` não têm nenhuma
  ocorrência sobre superfície escura hoje — não foi criada variante `-on-dark`
  pra eles (token que ninguém usa também é dívida).
- A maior parte das ocorrências (~90) estava em `index.css`, inteiramente
  dentro das classes `.landing-*` — cor exata dos tokens já existentes
  (`ink`, `primary`, `signal` etc.), só escritas por extenso em vez de
  referenciar variável. Todas viraram `var(--olume-*)`.
- Foram criadas 9 variáveis CSS novas (`--olume-ink-muted`,
  `--olume-neutral-soft`, `--olume-canvas`, `--olume-surface-subtle`,
  `--olume-border`, `--olume-border-strong`, `--olume-primary-hover`,
  `--olume-primary-soft`, `--olume-success`) espelhando o padrão que já
  existia pra `--olume-ink`/`--olume-ink-strong`/`--olume-primary`/
  `--olume-signal`: fixas, **nunca** redefinidas em `html[data-theme="dark"]`,
  porque servem pra superfície permanentemente escura (marca, sidebar do
  operador, landing). O **valor** de cada uma já estava em `DESIGN.md`; só
  faltava a variável de implementação. Por isso nenhum token novo entrou em
  `DESIGN.md` — não houve lacuna real de token, só de fiação.

## Contraste medido (combinações sobre `ink` #071A15, superfície escura fixa)

| Combinação | Contraste | Onde é usada hoje | Veredito |
|---|---:|---|---|
| `success` (#16856A) texto sobre `ink` | 3,94:1 | nenhuma (só o -on-dark) | reprova, mas não está em uso direto |
| `success-on-dark` (#69DAB1) sobre `ink` | 10,50:1 | `.landing-demo-success` (ícone) | ok, em uso |
| `danger` (#C83C4A) texto sobre `ink` | 3,60:1 | nenhuma (só o -on-dark) | reprova, mas não está em uso direto |
| `danger-on-dark` (#FFB4A9) sobre `ink` | 10,58:1 | `Landing.jsx` erro do formulário | ok, em uso |
| `warning` (#B76A11) sobre `ink` | 4,35:1 | **nenhuma ocorrência sobre superfície escura** | não se aplica — sem uso, sem variante nova |
| `info` (#1674A8) sobre `ink` | 3,51:1 | **nenhuma ocorrência sobre superfície escura** | não se aplica — sem uso, sem variante nova |
| `signal` (#5BD6AE) sobre `ink` | 10,00:1 | marca (Brand.jsx), badge do login do operador | ok, sem precisar de variante |

Conclusão do critério 4 do ticket: **nenhuma combinação semântica em uso real
sobre superfície escura fica abaixo de 4,5:1.** O caso que motivou o ticket
(erro em vermelho sobre `ink` na landing) já tinha sido corrigido no PR #49
junto com `success-on-dark`; esta auditoria não encontrou nenhum outro caso
real pendente.

## Classificação por arquivo

### `index.css` (~90 ocorrências, todas em `.landing-*`, `.product-sidebar`, `.brand-mark-*`)
**Deriva.** Todas eram o valor exato de um token de `DESIGN.md`
(`ink` #071A15, `ink-muted` #4D625C, `neutral-soft` #778F87, `canvas` #F3F8F6,
`surface-subtle` #E9EFEA, `border` #D3E0DB, `border-strong` #BFD0CA,
`primary` #1F7A60, `primary-hover` #17664F, `primary-soft` #EAFBF5,
`signal` #5BD6AE, `success` #16856A), escritas por extenso em vez de
referenciar variável. Substituídas por `var(--olume-*)` — ver seção acima.
`#fff`/`#ffffff` (branco puro, ~10 ocorrências) ficaram como estão: não há
ambiguidade em "branco" e tokenizar não muda nada.

### `pages/Landing.jsx` (16 ocorrências)
**Deriva** (14) — mesmos tokens acima (`ink`, `primary`, `primary-hover`,
`border-strong`, `canvas`, `surface-subtle`), trocados por
`bg-[var(--olume-*)]`/`text-[var(--olume-*)]`. **Justificada** (2) —
`border-[#4D625C]/50` (2x, linhas com o divisor do formulário de
demonstração): o modificador de opacidade do Tailwind (`/50`) não decompõe um
`var()` que guarda uma string hex em canais RGB, só funciona com o padrão
`rgb(var(--x) / alpha)` que as variáveis `--color-*` já usam. Mantido literal;
documentado aqui para não reaparecer como "esquecido".

### `components/ui/Brand.jsx` (5 ocorrências)
**Deriva.** `#5BD6AE`/`#1F7A60` eram exatamente `signal`/`primary`, fixados
como atributo SVG em vez de propriedade CSS. Trocados por `style={{ stroke:
'var(--olume-signal)' }}` (e equivalentes) — atributo de apresentação SVG não
garante resolução de `var()` em todos os engines, `style` garante.

### `pages/operador/LoginOperador.jsx` (3 ocorrências)
**Deriva.** Badge "Acesso interno restrito": `border-[#5BD6AE]/35`,
`bg-[#5BD6AE]/10` e `text-[#7BE0C2]`. As duas primeiras já eram o valor exato
de `signal`; a Tailwind já expõe esse mesmo valor com suporte a opacidade via
`brand-400` (`--color-brand-400` = 91 214 174 = #5BD6AE, idêntico nos dois
temas) — trocadas por `border-brand-400/35`/`bg-brand-400/10`. O texto usava
um tom de menta mais claro e inventado (#7BE0C2, 11,38:1 sobre `ink`) quando o
`signal` puro já passa com folga (10,00:1) — trocado por `text-brand-400`.
Mudança visual mínima e intencional (correção de deriva), não um redesign.

### `context/ThemeContext.jsx` (2 ocorrências, `amostra` do seletor de tema)
**Justificada**, documentado inline: o preview do seletor precisa mostrar o
valor literal de CADA tema ao mesmo tempo (claro e escuro lado a lado);
`var()` só resolveria o tema ativo nos dois quadradinhos.

### `components/TagsConversa.jsx` e `pages/admin/Departamentos.jsx` (`CORES`, 8 ocorrências no total)
**Justificada**, documentado inline nos dois arquivos: paleta categórica pra
diferenciar tags/departamentos visualmente — não é o conjunto semântico do
DESIGN.md, é um "qual dos N" arbitrário escolhido pelo usuário num seletor de
6 opções fixas. **Achado correlato (fora do escopo deste ticket):** a 2ª cor
da paleta (`#47A987`) com o texto branco do chip mede **2,88:1**, abaixo de
AA — a paleta é usada com texto branco por cima em `TagsConversa.jsx`,
`pages/admin/Atendentes.jsx` e `pages/Conversas.jsx`. Não foi corrigido aqui
porque exige uma decisão de design (qual tom substitui) e o ticket restringe
escopo a "cores literais fora de token nos temas claro/escuro dos tokens
DESIGN.md", não a paletas categóricas. Recomendo um ticket dedicado.

### `pages/admin/FluxoEditor.jsx`
- **`TIPOS` (7 cores, linhas ~13-19):** justificada, documentado inline —
  paleta categórica do editor visual de fluxo (cor por tipo de passo), duas
  delas coincidem por acaso com `primary`/`danger` (verde = segue,
  vermelho = encerra), não são referência ao token. **Achado correlato:** a
  cor de `menu` (`#B7791F`) com texto branco no hover mede 3,64:1, mesma
  situação do `CORES` acima — documentado, não corrigido, mesmo motivo.
- **`#e5ddd3`/`#d9fdd3` (preview do WhatsApp):** justificada, documentado
  inline — replica de propósito o wallpaper e a bolha de mensagem do WhatsApp
  real, é o "como o cliente vai ver", não pode usar cor da Olume.

### `pages/Conversas.jsx`, `pages/admin/{Atendentes,Dashboard,Monitor}.jsx`
Ocorrências de `d.cor || '#1F7A60'` (fallback) e o pseudo-departamento
"Geral" (`#80978F` em `Conversas.jsx`): **justificada** — são bolinhas/barras
decorativas ao lado de texto em token próprio (`text-stone-*`), não carregam
contraste sozinhas; `#1F7A60` é o próprio `primary` usado como valor-padrão
quando a API não manda cor. `#80978F` é um cinza-esverdeado neutro só pra
"sem departamento", documentado inline em `Conversas.jsx`.

## Mecanismo anti-reincidência (proposta, não implementada)

Não implementado por instrução do ticket ("Não implemente sem combinar").
Duas opções de custo baixo, do mais simples ao mais completo:

1. **Regra de lint (ESLint, custom ou `eslint-plugin-tailwindcss`
   `no-arbitrary-value` com allowlist):** bloquear `#[0-9a-fA-F]{3,8}` dentro
   de `className`/`style` em `client/src/**`, com exceção explícita por
   comentário (`// cor-literal-ok: <motivo>`) pros casos justificados listados
   acima. Roda no CI (`client-build` ou um step novo), pego na hora do PR.
2. **Teste de contraste automatizado:** um script Node (sem browser) que lê
   os tokens de `DESIGN.md` + as combinações "on-dark" e falha se qualquer
   combinação semântica documentada como "usada sobre superfície escura"
   ficar abaixo de 4,5:1 — pega regressão se alguém reintroduzir `danger`
   puro sobre `ink` no futuro. Mais caro que o lint, mas testa o que
   realmente importa (contraste, não só "tem hex literal").

Recomendo começar pela opção 1 (lint) por ser mais barata e já cobrir o
sintoma raiz (cor inventada em vez de token); a opção 2 é um complemento se o
produto crescer o número de combinações "on-dark".
