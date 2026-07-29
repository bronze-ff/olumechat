# client/ — mapa e regras locais

> Delta do `../AGENTS.md` (leia o raiz primeiro). `CLAUDE.md` desta pasta é só o import.

## Mapa

| Pasta | Responsabilidade |
|---|---|
| `src/pages/` | Landing, Login, Conversas (app do atendente) |
| `src/pages/admin/` | Painel do cliente (`Admin.jsx` = shell de abas; uma page por aba) |
| `src/pages/operador/` | Painel interno Olume (`nav.js` = seções; `OperadorShell` = layout) |
| `src/components/layout/` | Shells, Header, ProtectedRoute/RotaOperador, SuporteBadge |
| `src/services/` | `api.js` (sessão do CLIENTE) e `apiOperador.js` (sessão do OPERADOR) — **nunca misture** |
| `src/context/AuthContext.jsx` | login/logout/encerrarSuporte — leia os comentários de corrida antes de mexer |
| `src/hooks/` | `useEventStream` (SSE com ticket), `useScrollEdges` (fade de abas) |

## Regras locais

- **Dois eixos de sessão**: `token` (cliente) vs `token_operador` — axios, guards e rotas
  separados de propósito. Sair da sessão de suporte é **navegação dura**
  (`location.replace`) — não "conserte" para SPA navigate: reintroduz a corrida com o
  `ProtectedRoute` (FIL-90).
- **Tema claro/escuro**: superfícies tematizadas usam variáveis (`var(--color-surface)`
  etc.) — nunca cor literal (`from-white`, `bg-white` fixo) em elemento que aparece nos
  dois temas (lição do PR #35).
- Scrollbar é padrão GLOBAL via `index.css` — não crie estilos de scrollbar locais.
- Estado servidor = React Query; chaves hierárquicas (`['numeros', ...]`) para a
  invalidação por prefixo alcançar descendentes (lição do PR #34). Formulários não podem
  ser reinicializados por refetch de mutação vizinha (inicialize uma vez).
- Mobile-first: barras de abas com scroll horizontal precisam do indicador de continuação
  (`useScrollEdges`); modais viram bottom-sheet no mobile.
- Texto de UI em PT-BR, tom direto, sem jargão de implementação (`PRODUCT.md`).
- Verificação mínima antes do push: `npm run build`.
