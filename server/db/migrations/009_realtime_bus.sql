-- FIL-72 — LISTEN/NOTIFY não exige objetos de schema.
-- Esta migração idempotente registra a versão do porte sem criar tabela: os
-- canais são efêmeros e o hub usa pg_notify() em uma conexão direta.
DO $$
BEGIN
  PERFORM 1;
END
$$;
