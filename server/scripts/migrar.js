// scripts/migrar.js — Aplica os arquivos de db/migrations/ em ordem numérica.
//
//   cd server && npm run migrar
//
// Usa MIGRATION_DATABASE_URL se existir, senão DATABASE_URL. No Neon, prefira
// a connection string DIRETA (host SEM "-pooler") para DDL: o pooler em
// transaction mode não é o lugar de rodar CREATE TABLE/ROLE — e também
// quebraria o lock abaixo, que é de sessão (ver nota do LOCK_SQL).
//
// As migrações são idempotentes por contrato (ver o cabeçalho de cada uma),
// então rodar de novo é seguro e é assim que se aplica uma migração nova.
// Cada arquivo roda em UMA transação: se falhar no meio, nada daquele arquivo
// fica aplicado.
//
// FIL-92 (P0.4): o entrypoint do container roda este script antes do `node
// app.js`, e dois containers podem subir juntos durante um rolling update.
// Por isso o script inteiro roda sob um pg_advisory_lock global — o segundo
// processo espera o primeiro liberar em vez de disputar DDL em paralelo.
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

// Lock consultivo DE SESSÃO (pg_advisory_lock, não o _xact_): precisa que
// todas as queries deste script rodem na MESMA conexão física — verdadeiro
// para MIGRATION_DATABASE_URL/DATABASE_URL_DIRECT (conexão direta), mas não
// garantido atrás de um pooler em transaction mode.
const LOCK_KEY_SQL = "hashtext('olume-chat:migrar')::bigint";

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrar] defina MIGRATION_DATABASE_URL (ou DATABASE_URL) no .env');
    process.exit(1);
  }
  const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  if (!arquivos.length) {
    console.log('[migrar] nenhuma migração em db/migrations/');
    return;
  }

  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    console.log('[migrar] aguardando lock global de migração...');
    await c.query(`SELECT pg_advisory_lock(${LOCK_KEY_SQL})`);
    console.log('[migrar] lock obtido');
    try {
      for (const arquivo of arquivos) {
        process.stdout.write(`[migrar] ${arquivo} ... `);
        const sql = fs.readFileSync(path.join(DIR, arquivo), 'utf8');
        await c.query('BEGIN');
        try {
          await c.query(sql);
          await c.query('COMMIT');
          console.log('ok');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => {});
          console.log('FALHOU');
          throw err;
        }
      }
      const t = await c.query(
        `SELECT count(*)::int AS tabelas,
                count(*) FILTER (WHERE rowsecurity)::int AS com_rls
           FROM pg_tables WHERE schemaname = 'public'`
      );
      const { tabelas, com_rls: comRls } = t.rows[0];
      console.log(`[migrar] pronto — ${tabelas} tabelas, ${comRls} com RLS habilitada`);
      if (tabelas !== comRls) {
        console.error('[migrar] ATENÇÃO: há tabela sem RLS — isolamento de tenant incompleto');
        process.exitCode = 1;
      }
    } finally {
      await c.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`).catch(() => {});
    }
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error('[migrar] erro:', err.message);
  process.exit(1);
});
