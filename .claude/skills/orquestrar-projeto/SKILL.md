---
name: orquestrar-projeto
description: |
  Orquestra um conjunto de tickets do Linear em ondas com portao de merge:
  cria uma worktree filha no Orca por ticket, sobe um agente Claude autonomo
  em cada uma, monitora ate o PR abrir, roda a review cruzada com o Codex,
  tria os achados, manda o worker aplicar os validos, e libera a proxima onda
  quando o humano faz merge. Use quando o usuario disser "orquestre",
  "rode a onda", "toque esses tickets", ou colar IDs/URL de projeto do Linear
  com intencao de implementar tudo.
---

# Orquestrar tickets em ondas (Orca + Claude + Codex)

Voce e o **orquestrador**, nao o implementador. Nao escreva codigo de
producao. Seu trabalho: ler os tickets, montar o grafo, criar worktrees,
despachar agentes, monitorar, rodar a review cruzada, triar achados e
relatar. Quem faz merge e o humano — o merge dele e o portao da proxima onda.

Argumentos: IDs de tickets (`FIL-56 FIL-57`) ou nome/URL de projeto do
Linear. Se nao vier nada, pergunte.

## Politica fixa (nao re-pergunte)

- **Ondas com portao de merge** — ticket so comeca quando TODOS os blockers
  dele estao mergeados na `main`. Todo PR aponta pra `main`. Sem branch
  empilhada.
- **Claude implementa, Codex revisa.** O plano do Codex e o escasso: ele NAO
  implementa; entra uma vez por ticket, depois do PR aberto, como segunda
  opiniao de outra familia. Escale um ticket dificil mudando o modelo do
  Claude, nunca trocando de fornecedor.
- **Modelos: Fable e SO do orquestrador.** Worker de implementacao NUNCA roda
  Fable. Escolha por ticket: **Opus** pra ticket pesado/de fundacao (define
  contrato que outros consomem), **Sonnet** pro porte/feature padrao, **Haiku**
  pra tarefa trivial/mecanica. O agente lancado pelo Orca herda o modelo
  default — troque SEMPRE logo apos o spawn (`/model <x>` via `terminal send`)
  ou lance ja certo no fallback (`--command "claude --model <x>"`).
- **Voce nunca faz merge.** Resultado de uma onda = PRs abertos + achados
  triados + relatorio.
- **PRODUCAO ESTA NO AR** (`olumechat.com.br`), com staging espelhado. Isso muda
  o padrao de risco: mudanca de schema, de contrato de API ou de variavel de
  ambiente pode derrubar cliente. Todo ticket que toca esses pontos precisa
  dizer no PR **como sobe** (migracao expand/contract? precisa variavel nova no
  Coolify? exige rebuild por ser `VITE_*`?). Ver `docs/AMBIENTES.md`.
- **A CI e portao real.** A `main` e protegida e exige `server-test`,
  `server-test-rls` e `client-build` verdes. Worker que abre PR com CI vermelha
  nao terminou o trabalho — mande corrigir antes da review cruzada.
- **Toda worktree filha nasce de `origin/main` fresca** — `git fetch origin
  main` antes de cortar qualquer onda.

## Fase 0 — Ler os tickets

1. Leia cada ticket por completo. Da worktree, a fonte e o CLI:
   `orca linear issue <ID> --full --json` (confira flags com
   `orca linear --help`; pra projeto inteiro, use a busca do
   `orca linear`).
2. Dependencia e SO o que esta em `blockedBy` — nunca inferida do titulo.
3. Ticket vago demais pra virar prompt autocontido: pare e pergunte ao
   humano a decisao especifica que falta. Nao invente escopo.

## Fase 1 — Grafo e tabela de ondas

- Onda do ticket = `max(onda de cada blocker) + 1`; sem blocker aberto =
  Onda 1. Ticket ja `Done` conta como blocker satisfeito.
- Imprima a tabela: `| Onda | Tickets | Desbloqueia |`. Marque fan-in
  (2+ blockers) explicitamente.

## Fase 2 — Despachar uma onda

Antes de qualquer criacao: `git fetch origin main`.

Para cada ticket da onda (crie TODAS as worktrees antes de acompanhar
qualquer uma — paralelo de verdade, nao fila):

1. **Escreva o prompt num arquivo** (scratchpad). Conteudo: instrucao de ler
   o ticket + o contrato fixo abaixo. Nunca cole texto longo direto no
   `terminal send` — a caixa de input embaralha; arquivo + ponteiro de uma
   linha e a forma confiavel (aprendido na pratica).

   Contrato fixo do worker (embuta no prompt):
   > 1. Leia o ticket com `orca linear issue --current --full --json` e
   >    implemente EXATAMENTE o que ele diz — escopo, fora-de-escopo, ACs.
   > 2. Leia `docs/WORKFLOW.md` antes de criar branch/PR. O Orca cria a
   >    branch como `<usuario>/<nome>`; renomeie pro padrao
   >    `<tipo>/<descricao>` do WORKFLOW.md §1 ANTES do primeiro push.
   > 3. Rode a suite (server e/ou client conforme o ticket) e so avance se
   >    passar de verdade.
   > 4. Abra o PR contra `main` com `gh pr create --base main`. NAO faca
   >    merge, NAO toque na `main`.
   > 5. Anexe o PR no ticket: `orca linear attach --current --url <url>
   >    --title "PR"` e mova o status pra review.
   > 6. Duvida que o ticket nao responde: NAO decida; imprima uma linha
   >    comecando com `PERGUNTA:` e pare.
   > 7. Producao esta no ar. Se a mudanca exigir **migracao**, ela e
   >    expand/contract (nunca remove coluna na mesma release que para de
   >    usar). Se exigir **variavel de ambiente nova**, liste no corpo do PR
   >    o nome, para que serve e o valor de exemplo — nunca o valor real.
   > 8. Confira que a **CI ficou verde** no PR (`gh pr checks <n>`). Vermelha =
   >    trabalho inacabado.

2. **Crie a worktree ja com o agente** (o lancamento automatico funciona —
   exige "Wait for setup" DESLIGADO no Windows, ver playbook):

   ```bash
   orca worktree create --name <slug> --linear-issue <ID> \
     --agent claude --prompt "$(cat <arquivo-prompt>)" --json
   ```

   Se o agente nao subir (bug de plataforma), fallback em dois passos:
   `orca worktree create --name <slug> --linear-issue <ID> --json` e depois
   `orca terminal create --worktree name:<slug> --command "claude" --focus
   --json`, seguido de `terminal wait --for tui-idle` e `terminal send` com
   o ponteiro pro arquivo.

3. Registre worktree, terminal handle e ticket na sua tabela de estado.

## Fase 3 — Monitorar os workers

- Acompanhe com `orca worktree ps` e `orca terminal wait --terminal <h>
  --for tui-idle --timeout-ms 600000` (worker ocioso = terminou ou travou).
- Worker ocioso: leia o final da saida (`orca terminal read`) e verifique o
  PR de verdade: `gh pr view <n> --json baseRefName,state,files`. Confirme
  base `main` e arquivos dentro do escopo do ticket.
- Linha `PERGUNTA:` na saida: responda a partir do ticket; se o ticket nao
  responde, leve ao humano. Nunca chute.

## Fase 4 — Review cruzada (Codex), por ticket, assim que o PR abre

Nao espere a onda inteira: revise cada PR quando ele abrir.

```bash
orca terminal create --worktree name:<slug> --title review \
  --command "codex review --base main 2>&1 | Tee-Object -FilePath codex-review.log; exit" --json
orca terminal wait --terminal <handle> --for exit --timeout-ms 900000
# leia o relatorio do ARQUIVO <worktree>/codex-review.log (o .gitignore cobre *.log)
```

No Windows o Orca embrulha o comando num PowerShell persistente: sem o
`; exit` o shell fica vivo depois do codex, a aba gira pra sempre e o
`wait --for exit` nunca dispara. E depois do exit a scrollback se perde —
por isso o Tee-Object gravando em arquivo e a leitura pelo arquivo, nao
pelo terminal.

Regras aprendidas na pratica:
- `codex review --base main` NAO aceita prompt junto (erro de argumento).
  Instrucao padrao basta.
- **Exija saida visivel.** Sem relatorio impresso != review limpa. Erro 400
  `model requires a newer version of Codex` = CLI desatualizado:
  `npm install -g @openai/codex@latest` e rode de novo.
- Cota do Codex estourada: registre "review nao feita por cota", siga em
  frente e diga isso no relatorio. Trabalho nao se perde; so a segunda
  opiniao.

**Triagem** (comentario de review e insumo, nunca ordem):
- Correcao/regressao/teste faltando, confirmado no codigo: escreva a
  instrucao de fix num ARQUIVO na worktree do ticket e mande o worker
  aplicar (ponteiro de uma linha via `terminal send`). Commit + push na
  MESMA branch — sem PR novo.
- Achado que contradiz o ticket: nao decida; apresente ao humano o achado e
  o texto do ticket, com sua recomendacao.
- Invalido/estilo/fora de escopo: registre o motivo e nao mexa.

## Fase 5 — Portao de merge, staging e proxima onda

- Monitore merge com `gh pr view <n> --json state,mergedAt` (poll com
  sleep; nao ha CI de testes neste repo — a verificacao real e a suite
  local que o worker rodou + a review cruzada).
- A cada merge: `git fetch origin main`, recompute blockers, e despache
  (Fase 2) todo ticket que ficou livre. Repita ate acabar.
- Ao final: tabela com ticket, PR, estado da review, e pendencias que so o
  humano fecha (ex.: testar instalacao no celular, flag pra ligar).
- **Depois do merge, o trabalho da onda ainda nao acabou**: informe ao humano o
  que precisa acontecer para a mudanca chegar em producao — deploy em
  **staging** primeiro, validacao, e so entao promocao da MESMA imagem para
  producao. Se a onda criou variavel de ambiente, repita no relatorio final em
  quais dos quatro aplicativos do Coolify ela precisa entrar (`frontend`,
  `backend`, `frontend-staging`, `backend-staging`).

## Pegadinhas (custaram horas reais)

- **Texto longo via `terminal send` embaralha.** Instrucao vai em arquivo;
  o send leva so "leia e execute <arquivo>". Confira a caixa antes do Enter.
- **`--base` + prompt no `codex review` = erro.** Use so `--base main`.
- **Review sem saida nao e review.** O 400 do modelo pode falhar em
  silencio; exija o relatorio impresso.
- **Worktree filha de main fresca.** Cortar de `origin/main` velha faz o
  worker nao ver o codigo do blocker e reimplementar.
- **Branch nasce `<usuario>/<nome>`** (gitUsername do Orca); o contrato
  manda renomear antes do push. Nunca renomeie DEPOIS do PR aberto via
  `git branch -m` + push — isso fecha o PR; pelo GitHub (Rename branch) o
  PR e reapontado.
- **`orca linear attach` quando o PR ja existe;** nao invente flags — na
  duvida, `orca linear --help`.
- **Variavel `VITE_*` e build-time.** Mudou valor, precisa rebuildar — nao
  basta reiniciar o container.
- **Migracao roda no entrypoint, antes do servidor subir.** Migracao quebrada
  nao derruba producao (o container novo nao fica pronto), mas trava o deploy.
- **Slash command via `terminal send` no Git Bash vira caminho.** O MSYS
  converte `/model opus` em `C:/Program Files/Git/model opus` antes de chegar
  no TUI — e a mensagem estranha ainda pode cancelar a acao em andamento do
  worker. Envie slash commands pelo PowerShell, ou prefixe
  `MSYS_NO_PATHCONV=1` no bash.
