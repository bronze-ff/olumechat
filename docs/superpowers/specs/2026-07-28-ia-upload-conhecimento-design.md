# Upload de arquivo na base de conhecimento

**Data:** 2026-07-28
**Fatia:** 4 de 4 do roadmap de IA (FIL-86)
**Estado:** aprovado, pronto para plano de implementação

## Problema

O admin tem cardápio, catálogo e tabela de preços em PDF/planilha e hoje precisa copiar e
colar tudo à mão na base de conhecimento (FIL-83). Conveniência grande, mas a extração não
pode ser silenciosa — texto embaralhado entrando direto no prompt é pior que o trabalho manual.

## Escopo desta fatia

Dentro:

- Extração de texto de PDF (com camada de texto), XLSX e CSV
- Preview editável + revisão obrigatória antes de virar bloco
- Divisão automática em múltiplos blocos quando passa do limite

Fora:

- OCR (PDF escaneado → erro claro pedindo o arquivo original ou o texto colado)
- Guardar o arquivo original
- RAG (o medidor da FIL-83 continua sendo o guarda; esta fatia é o gatilho natural para
  reconsiderar se catálogos reais estourarem a faixa vermelha)

## Decisões confirmadas

### Fluxo

1. Admin clica "Enviar arquivo" na seção **Base de conhecimento** da tela Agente de IA.
2. `POST /api/ia-conhecimento/extrair` (multipart) extrai e devolve **blocos propostos** —
   `[{ titulo, conteudo }]` — **sem persistir nada** no servidor.
3. O client mostra preview editável (título e conteúdo de cada bloco proposto).
4. O admin revisa, corrige e salva → usa o CRUD existente da FIL-83
   (`POST /api/ia-conhecimento`), que já valida limites, audita e invalida cache.

Nada entra na base sem um humano ter lido. A extração é stateless: falhou ou o admin
abandonou, não sobrou lixo.

### Formatos e bibliotecas

- **PDF com camada de texto** — `pdf-parse` ou `pdfjs-dist` (decidir no plano; critério:
  **zero binário nativo** no deploy Windows).
- **XLSX** — lib já usada no projeto se houver; senão `exceljs`. Render: uma linha de texto
  por registro, colunas rotuladas pelo cabeçalho (`Coluna: valor · Coluna: valor`).
- **CSV** — parser leve (detectar `,`/`;`, encoding UTF-8/latin1).
- **PDF escaneado** (sem camada de texto) → `422` com mensagem clara: "este PDF é uma imagem;
  envie o arquivo original ou cole o texto". OCR fora.

### Divisão em blocos

- Extraído acima de 20.000 chars (limite de bloco da FIL-83) → dividido em blocos
  `"Título (1/2)"`, `"Título (2/2)"` no preview, cortando em fronteira de parágrafo/linha.
- Título default = nome do arquivo sem extensão (editável no preview).
- Respeita o máximo de 50 blocos por empresa: proposta que estouraria o total → erro claro
  antes de mostrar o preview.

### Limites

- Arquivo: **10 MB**. Planilha: ~10.000 linhas (acima disso não cabe no orçamento de prompt de
  qualquer forma). Erro claro **antes** de processar.
- `POST /extrair`: ADMIN, atrás de `ia_habilitada`, mesmo padrão de permissão da FIL-83.
  Rate limit por usuário (mesmo padrão do `/testar`).

## Tela

Na seção Base de conhecimento (IaConfig.jsx):

- Botão "Enviar arquivo (PDF, XLSX, CSV)" ao lado de "Adicionar bloco".
- Preview em modal/expansão: lista de blocos propostos, cada um com título e conteúdo
  editáveis, contador de caracteres e aviso do medidor (quanto o total vai crescer).
- Ações: salvar todos, salvar individualmente, descartar.
- O medidor da FIL-83 reage na hora ao salvar (invalidação já existe).

## Testes

- PDF texto → blocos propostos fiéis; PDF escaneado → 422 com a mensagem certa
- XLSX/CSV → linhas rotuladas; encoding latin1 não vira mojibake
- Split: >20k divide em fronteira de parágrafo; títulos numerados; total >50 blocos → erro
- Limites: >10 MB e >10k linhas → erro antes de processar
- `POST /extrair` não persiste nada (nem em erro, nem em sucesso)
- Permissões: papel errado 403; add-on desligado 400
- Salvar usa o CRUD existente (auditoria + invalidação de cache acontecem)

## Decisões conscientes

| Decisão | Gatilho para reconsiderar |
|---|---|
| Sem OCR | recusa frequente de PDF escaneado em produção |
| Original não guardado | admins re-subindo o mesmo arquivo com frequência |
| Sem RAG | catálogo real estourando a faixa vermelha do medidor |
