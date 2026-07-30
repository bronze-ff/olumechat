'use strict';
// FIL-97 — migração 026: app da Meta por cliente (App ID/Secret + caminho do
// webhook em `meta_conexao`, tenant do caminho em `webhook_evento`).
//
// Teste de CONTRATO sobre o .sql (mesmo padrão das 023/024): produção está no
// ar, o histórico inteiro roda a cada deploy e uma migração que remove coluna ou
// perde idempotência não dá para descobrir depois. Não há camada de integração
// aqui porque nada nesta migração cria tabela nova — só colunas nullable numa
// tabela que já está no bloco `isolamento_tenant` da 008.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ARQUIVO = path.join(__dirname, '..', 'db', 'migrations', '026_meta_app_por_cliente.sql');
const SQL = fs.readFileSync(ARQUIVO, 'utf8');
// Para asserções de AUSÊNCIA: o cabeçalho explica as decisões e não pode fazer
// o teste passar nem falhar.
const EXECUTAVEL = SQL.replace(/--[^\n]*/g, '');

test('026: expand/contract — só ADD COLUMN IF NOT EXISTS, nada é removido', () => {
  assert.match(SQL, /ALTER TABLE meta_conexao ADD COLUMN IF NOT EXISTS app_id varchar\(40\)/);
  assert.match(SQL, /ALTER TABLE meta_conexao ADD COLUMN IF NOT EXISTS app_secret_criptografado varchar\(4000\)/);
  assert.match(SQL, /ALTER TABLE meta_conexao ADD COLUMN IF NOT EXISTS webhook_identificador varchar\(64\)/);
  assert.match(EXECUTAVEL, /ADD COLUMN IF NOT EXISTS webhook_tenant_id bigint REFERENCES tenant \(id\)/);
});

test('026: nenhuma coluna nova é NOT NULL (a linha existente não pode quebrar)', () => {
  const adds = EXECUTAVEL.match(/ADD COLUMN IF NOT EXISTS[^;]+/g) || [];
  assert.equal(adds.length, 4);
  for (const add of adds) {
    assert.ok(!/NOT NULL/i.test(add), `coluna nova NOT NULL sem default: ${add.trim()}`);
  }
});

test('026: o caminho do webhook é ÚNICO globalmente (é ele que resolve o tenant)', () => {
  assert.match(
    EXECUTAVEL,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_conexao_webhook_ident\s+ON meta_conexao \(webhook_identificador\)\s+WHERE webhook_identificador IS NOT NULL/
  );
});

test('026: reaplicar não pode perder dado — sem DROP/DELETE/TRUNCATE/UPDATE', () => {
  assert.ok(!/\bDROP\s+(TABLE|COLUMN)\b/i.test(EXECUTAVEL));
  assert.ok(!/\bTRUNCATE\b/i.test(EXECUTAVEL));
  assert.ok(!/\bDELETE\s+FROM\b/i.test(EXECUTAVEL));
  assert.ok(!/\bUPDATE\s+\w+\s+SET\b/i.test(EXECUTAVEL));
});

test('026: não afrouxa a RLS de meta_conexao nem de webhook_evento', () => {
  // meta_conexao já é isolada por tenant (008) e webhook_evento é tabela de
  // SISTEMA com policy USING(false) + REVOKE (023). Uma migração que mexesse em
  // policy ou desse GRANT aqui abriria dado entre empresas sem ninguém notar.
  assert.ok(!/CREATE POLICY/i.test(EXECUTAVEL));
  assert.ok(!/DROP POLICY/i.test(EXECUTAVEL));
  assert.ok(!/\bGRANT\b/i.test(EXECUTAVEL));
  assert.ok(!/DISABLE ROW LEVEL SECURITY/i.test(EXECUTAVEL));
});

test('026: a coluna do webhook_evento NÃO se chama tenant_id (não é tabela de tenant)', () => {
  // `webhook_evento` continua sendo tabela de sistema: o nome distinto impede
  // que alguém leia isto como "agora dá para filtrar por tenant aqui".
  assert.ok(!/ADD COLUMN IF NOT EXISTS tenant_id\b/.test(EXECUTAVEL));
  assert.match(EXECUTAVEL, /webhook_tenant_id/);
});
