# Setup do repositório — MC-Zap (Multicanal · Atendimento WhatsApp)

Passo a passo para sair do `git clone` até o sistema rodando. Para o **detalhe**
de cada parte (variáveis de ambiente, estrutura do banco, arquitetura, deploy),
veja o [`README.md`](README.md) — aqui é o caminho curto e linear.

> Convenção: `>` PowerShell/CMD no Windows. Os comandos `npm` são iguais em bash.

---

## 1. Pré-requisitos

| Item | Versão / nota |
|---|---|
| **Node.js** | 20 LTS+ (o instalador empacota 20.19.0). `node -v` |
| **Oracle Instant Client** | obrigatório — o backend usa **thick mode** (`node-oracledb`). Aponte `ORACLE_LIB_DIR` para a pasta dele, ou deixe-o no `PATH`. |
| **Acesso ao Oracle** | banco WinThor `MCANAL` (host/porta/serviço) e permissão para criar o schema **MCLABS** (ou pedir ao DBA). |
| **Conta Meta / WhatsApp Cloud API** | App + WABA + número, com App Secret, token permanente (System User) e Phone Number ID. |
| **Inno Setup 6** | *só* se for **gerar o instalador `.exe`** (deploy). Não precisa para rodar em dev. |

---

## 2. Clonar

```bash
git clone git@github.com:MulticanalAtacado/mc-atendimentos.git
cd mc-atendimentos
```

O repositório tem dois apps independentes: **`server/`** (Node/Express) e
**`client/`** (React/Vite). Cada um tem seu `package.json`.

---

## 3. Banco de dados (uma vez por ambiente)

1. **Criar o schema** (como DBA/SYS) — edite a senha dentro do arquivo antes:
   `scripts/00_create_schema.sql`.
2. **Rodar os scripts MC_ZAP_* na ordem**, conectado como **MCLABS**. A sequência
   completa (e o que cada script faz) está na seção
   [**Banco de dados → Scripts**](README.md#banco-de-dados) do README:

   ```
   instalar_em_nova_empresa.sql   (12 tabelas base)
   02_fase5a → 03_fase5b → 04_fase5c → 05_config → 06_atalhos →
   07_origem_permissao → 08_campanhas → 10_numero_permite_ativo → 11_atendente_numero
   ```
3. **GRANTs no WinThor** (como MCCANAL/DBA): `MC_SENHAS` (login), `PCCLIENT`
   (busca de cliente) e, para bot/campanha, `PCPREST`/`PCHISTCOB…` — ver
   `scripts/09_cobranca_selects.sql`.

> Os scripts **não** são idempotentes (rodar 2x dá erro) e exigem Oracle 12c+.
> Utilitários de manutenção: `scripts/apagar_conversa.sql`, `scripts/limpar_mc_zap.sql`.

---

## 4. Backend (`server/`)

```bash
cd server
npm install

# configurar o ambiente:
copy .env.example .env        # (bash: cp .env.example .env)
# editar o .env e preencher Meta + Oracle (ver a TABELA de variáveis no README).
# JWT_SECRET pode ficar VAZIO: o sistema gera um forte e grava no 1º boot.

npm test                      # node:test — suíte completa (sem precisar de banco/rede)
npm run dev                   # nodemon → http://localhost:3001
```

Quem vira **ADMIN** no primeiro acesso: as matrículas listadas em
`DIRETORES_MATRICULAS` no `.env`.

---

## 5. Frontend (`client/`)

```bash
cd client
npm install
npm run dev                   # http://localhost:5173 (proxy /api → :3001)
npm run build                 # gera client/dist (servido pelo Express em produção)
```

Em **dev** rode os dois (`server` e `client`) em terminais separados. Em
**produção** o Express serve o `client/dist` — não há servidor de frontend.

---

## 6. (Opcional) Gerar o instalador Windows

```powershell
& ".\installer\build.ps1"                 # bump de patch automático
& ".\installer\build.ps1" -Version 1.2.3  # versão explícita
# -> installer\dist\MC-Atendimento-Setup-vX.Y.Z.exe
```

Baixa Node portable + NSSM (cacheados), faz `vite build`, bundla o backend em
bytecode e empacota com Inno Setup. Detalhes em
[`installer/README.md`](installer/README.md).

---

## 7. Checklist pós-clone

- [ ] `node -v` ≥ 20 e Instant Client acessível (`ORACLE_LIB_DIR` ou `PATH`).
- [ ] Schema MCLABS criado e scripts rodados **na ordem**.
- [ ] `server/.env` preenchido (Meta + Oracle); **nunca** comitar este arquivo.
- [ ] `cd server && npm test` verde.
- [ ] `npm run dev` no server e no client; login com uma matrícula `DIRETORES_MATRICULAS`.

---

## Segurança — não comitar segredos

O `.gitignore` já bloqueia `server/.env`, `node_modules/`, `client/dist/`, os
artefatos de `installer/` e o relatório de auditoria. **Nunca** versione tokens,
senhas ou connect strings reais — use sempre o `.env` local (a partir do
`.env.example`). Modelo de ameaças e padrões em
[`README.md` → Modelo de segurança](README.md#modelo-de-segurança).
