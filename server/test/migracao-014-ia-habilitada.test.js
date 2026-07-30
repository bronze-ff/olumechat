// Teste de INTEGRAÇÃO da migração 014 (backfill de tenant.ia_habilitada) —
// Postgres real, mesmo padrão de test/db-tenant.test.js. Roda só com
// TEST_DATABASE_URL no ambiente; sem ela é PULADO (suíte segue verde em
// máquina sem banco).
//
// A 011 ligou tenant.ia_habilitada com DEFAULT 'N', o que também desligou
// tenants que já tinham ia_config ativa. A 014 religa esses — MAS não pode
// reacender um tenant que um operador desligou DE PROPÓSITO depois (definirIa
// não apaga ia_config, só corta o runtime — ver operador/tenants.js). Como
// scripts/migrar.js reaplica todo o histórico a cada deploy sem tabela de
// controle, a 014 usa ausência de linha em operador_auditoria
// ('ia_habilitada'/'ia_desabilitada') como prova de que o operador NUNCA
// decidiu esse flag pra aquele tenant.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SQL_014 = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '014_backfill_ia_habilitada.sql'),
  'utf8'
);

const URL_INTEGRACAO = process.env.TEST_DATABASE_URL;
const semBanco = !URL_INTEGRACAO;

test('014: religa quem nunca teve decisão do operador, preserva quem foi desligado de propósito, e é idempotente',
  { skip: semBanco && 'defina TEST_DATABASE_URL para rodar (usa Postgres real, migrações 001-014 aplicadas)' },
  async () => {
    const { Client } = require('pg');
    const admin = new Client({ connectionString: URL_INTEGRACAO });
    await admin.connect();
    const marca = `t014-${Date.now()}`;
    try {
      // A: nunca teve decisão do operador, mas TEM ia_config ativa (vítima do
      //    default clobber da 011) → a 014 deve religar.
      // B: ia_config ainda ativa, MAS o operador desligou de propósito depois
      //    (operador_auditoria tem 'ia_desabilitada') → a 014 NÃO pode reacender.
      // C: nunca teve ia_config nenhuma → nada a religar, fica 'N'.
      const t = await admin.query(
        `INSERT INTO tenant (nome, slug, ia_habilitada)
         VALUES ('A ${marca}', 'a-${marca}', 'N'),
                 ('B ${marca}', 'b-${marca}', 'N'),
                 ('C ${marca}', 'c-${marca}', 'N')
         RETURNING id, slug`
      );
      const A = t.rows.find((r) => r.slug === `a-${marca}`).id;
      const B = t.rows.find((r) => r.slug === `b-${marca}`).id;
      const C = t.rows.find((r) => r.slug === `c-${marca}`).id;

      await admin.query(
        `INSERT INTO ia_config (tenant_id, id, provider, modelo, api_key_criptografada, ativo)
         VALUES ($1, 1, 'anthropic', 'claude-x', 'cifrado', 'S'),
                ($2, 1, 'anthropic', 'claude-x', 'cifrado', 'S')`,
        [A, B]
      );
      await admin.query(
        `INSERT INTO operador_auditoria (tenant_id, acao) VALUES ($1, 'ia_desabilitada')`,
        [B]
      );

      // Roda a migração de verdade (o mesmo arquivo que scripts/migrar.js aplica).
      await admin.query(SQL_014);

      const estado1 = await admin.query(
        `SELECT slug, ia_habilitada FROM tenant WHERE id = ANY($1::bigint[])`,
        [[A, B, C]]
      );
      const por = Object.fromEntries(estado1.rows.map((r) => [r.slug, r.ia_habilitada]));
      assert.equal(por[`a-${marca}`], 'S', 'A: nunca decidido pelo operador + config ativa → religa');
      assert.equal(por[`b-${marca}`], 'N', 'B: operador desligou de propósito → NÃO reacende');
      assert.equal(por[`c-${marca}`], 'N', 'C: sem ia_config → nada a religar');

      // IDEMPOTÊNCIA: rodar de novo (é o que scripts/migrar.js faz a cada
      // deploy, sem tabela de controle) não muda nada.
      await admin.query(SQL_014);
      const estado2 = await admin.query(
        `SELECT slug, ia_habilitada FROM tenant WHERE id = ANY($1::bigint[])`,
        [[A, B, C]]
      );
      const por2 = Object.fromEntries(estado2.rows.map((r) => [r.slug, r.ia_habilitada]));
      assert.deepEqual(por2, por, 'rodar a 014 de novo não deveria mudar nada');
    } finally {
      // end() sempre, mesmo com a limpeza falhando: client aberto pendura o
      // processo do node:test e trava a suíte inteira (FIL-98).
      try {
        await admin.query(`DELETE FROM operador_auditoria WHERE tenant_id IN (
          SELECT id FROM tenant WHERE slug LIKE $1)`, [`%-${marca}`]).catch(() => {});
        await admin.query(`DELETE FROM ia_config WHERE tenant_id IN (
          SELECT id FROM tenant WHERE slug LIKE $1)`, [`%-${marca}`]).catch(() => {});
        await admin.query(`DELETE FROM tenant WHERE slug LIKE $1`, [`%-${marca}`]).catch(() => {});
      } finally {
        await admin.end().catch(() => {});
      }
    }
  });
