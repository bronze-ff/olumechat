# Scripts SQL — Multicanal - Atendimento WhatsApp

Estes scripts vão **dentro do instalador** (`.exe`) e ficam em
`C:\Program Files\MC-Atendimento\sql\` após instalar.

## Ordem de execução numa nova empresa / banco limpo

### 1. `00_create_schema.sql`  *(roda o DBA, como SYS)*
Cria o usuário/schema **MCLABS** (dono das tabelas) com grants e quota.
⚠️ Troque a senha no arquivo antes de rodar.

```
sqlplus sys/senha@//172.16.100.8:1521/MCANAL as sysdba @00_create_schema.sql
```

### 2. `instalar_em_nova_empresa.sql`  *(roda conectado como MCLABS)*
Cria as **12 tabelas** `MC_ZAP_*`, índices e constraints. Os objetos são
criados no schema de quem conecta (sem prefixo).

```
sqlplus MCLABS/senha@//172.16.100.8:1521/MCANAL @instalar_em_nova_empresa.sql
```

No final, o script lista as tabelas criadas (devem ser 12).

> **Atenção:** `instalar_em_nova_empresa.sql` **não é idempotente** — rodar
> duas vezes gera erro (tabela já existe). Requer **Oracle 12c+**
> (usa `IDENTITY` e `IS JSON`).

## Reset (fases futuras)
Quando houver dados e for preciso zerar mantendo a estrutura, criar um
`limpar_<entidade>.sql` (DELETE nas tabelas transacionais, preservando
configuração). Ainda não necessário nesta fase.
