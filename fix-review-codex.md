# Fix da review cruzada (Codex) — PR #43 / FIL-97

Um único achado (P2), confirmado. Mesma branch, commit + push, sem PR novo. Suite + build antes, e confira a CI verde (`gh pr checks 43`). Responda com 1 linha.

## P2 — o campo WABA ID não atualiza sozinho
`server/api/meta.js:114-121`: o operador que quiser corrigir **só** o WABA ID de uma conexão existente leva 400, porque `wabaId` está fora do `temAlgo`. E mesmo mandando outro campo junto, o valor é ignorado, porque o `guardar` só é chamado quando vem `accessToken`. Na prática, para trocar o WABA ID ele precisa **redigitar o token permanente** — que é o dado mais chato de obter e que ele pode nem ter em mãos naquele momento.

Fix: `wabaId` conta como mudança válida (entra no `temAlgo`) e é persistido mesmo sem `accessToken` novo. Preserve o comportamento atual dos demais campos (não sobrescrever o que não veio) e adicione teste do caminho "atualizo só o WABA ID".
