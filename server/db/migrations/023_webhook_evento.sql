-- ============================================================================
-- 023_webhook_evento.sql — FIL-94: a entrada da Meta vira DURÁVEL
-- (docs/DEPLOY_VPS.md §P0.6).
--
-- Problema que isto resolve: o webhook respondia 200 e processava em memória.
-- Um restart no instante seguinte ao ACK perdia a mensagem do cliente, sem
-- rastro nenhum. Agora o evento bruto é gravado ANTES do ACK e o processamento
-- é uma máquina de estados aqui: recebido → processando → concluido | falhou.
--
-- ⚠️ ÚNICA TABELA NOVA SEM tenant_id — E DE PROPÓSITO. A Meta não manda tenant:
-- quem sabe de quem é a mensagem é o `phone_number_id`, resolvido DEPOIS (ver
-- server/webhook/processEvent.js), e um mesmo evento pode trazer mais de um.
-- Então esta é uma tabela de SISTEMA, no MESMO PADRÃO de `provedor_credencial`
-- (015) e `operador`/`operador_auditoria` (005): RLS ENABLE+FORCE com policy
-- USING(false) e REVOKE ALL de `falatta_app`. Uma rota de tenant (comTenant(),
-- role falatta_app) que tentasse ler daqui recebe "permission denied", não uma
-- linha vazia silenciosa. O isolamento entre empresas continua ONDE SEMPRE
-- ESTEVE: nas tabelas de negócio (contato/conversa/mensagem), escritas dentro
-- de db.comTenant() pelo processEvent — nada disso muda.
--
-- ⚠️ POR QUE NÃO REUSAR `evento_webhook` (migração 001). Aquela tabela é
-- tenant-scoped (`tenant_id bigint NOT NULL DEFAULT tenant_atual()` + policy
-- `isolamento_tenant`), então é IMPOSSÍVEL gravar nela antes de resolver o
-- tenant: sem contexto, `tenant_atual()` é NULL e o INSERT viola o NOT NULL —
-- justamente o instante em que o evento precisa ficar durável. Ela veio do
-- de→para do fork e NENHUM código a usa: o webhook escrevia no nome Oracle
-- `MC_ZAP_EVENTO_WEBHOOK`, que não existe no Postgres — o log bruto não era só
-- volátil, ele nunca foi gravado. Esta migração NÃO apaga a tabela antiga:
-- remover tabela é decisão separada e o histórico não pode perder DDL.
--
-- ⚠️ `payload` é text, NÃO jsonb: jsonb rejeita `\u0000` dentro de string
-- ("unsupported Unicode escape sequence"). Um único evento com esse escape
-- viraria poison pill — INSERT falha, respondemos erro recuperável, a Meta
-- reenvia, falha de novo, para sempre. `text` guarda o corpo EXATAMENTE como
-- chegou (que é o ponto de um log bruto) e o parse fica no consumidor, onde um
-- payload torto derruba só aquele evento (vira `falhou` e sai do caminho).
--
-- Retenção: quem apaga é a aplicação (webhook/durabilidade.js), e SÓ evento
-- já `concluido` — `falhou` e pendentes ficam para investigação. O payload
-- carrega mensagem de cliente (LGPD), então guardar para sempre não é opção.
--
-- IDEMPOTENTE: pode rodar mais de uma vez (o deploy reaplica o histórico
-- inteiro). Nunca edite este arquivo depois de aplicado em um ambiente
-- compartilhado — mudança de schema é migração nova.
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhook_evento (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Hash dos identificadores da Meta do evento (wamid das mensagens, id+status
  -- dos recibos) — ou do corpo bruto, quando o payload não traz nenhum. É o que
  -- faz a reentrega da Meta colapsar sem colapsar evento novo. Ver
  -- server/webhook/eventoStore.js::chaveIdempotente.
  chave_idempotente varchar(120) NOT NULL,
  payload           text NOT NULL,
  -- Primeiro phone_number_id do payload, só para triagem/log (um evento pode
  -- ter mais de um; a verdade está no payload).
  phone_number_id   varchar(60),
  estado            varchar(12) NOT NULL DEFAULT 'recebido',
  tentativas        integer NOT NULL DEFAULT 0,
  erro              text,
  recebido_em       timestamptz NOT NULL DEFAULT now(),
  -- Início da última tentativa: é a base da janela de orfandade (um evento só
  -- é considerado abandonado depois de N minutos sem terminar).
  tentado_em        timestamptz,
  concluido_em      timestamptz,
  CONSTRAINT uq_whevento_chave  UNIQUE (chave_idempotente),
  CONSTRAINT ck_whevento_estado CHECK (estado IN ('recebido', 'processando', 'concluido', 'falhou')),
  CONSTRAINT ck_whevento_tent   CHECK (tentativas >= 0)
);

-- O que a recuperação varre a cada tick: pendente, mais velho primeiro.
-- Índice PARCIAL — a massa da tabela é 'concluido' e nunca é lida por aqui.
CREATE INDEX IF NOT EXISTS ix_whevento_pendente
  ON webhook_evento (recebido_em)
  WHERE estado IN ('recebido', 'processando');

-- O que a retenção apaga (só concluído, por data de conclusão).
CREATE INDEX IF NOT EXISTS ix_whevento_retencao
  ON webhook_evento (concluido_em)
  WHERE estado = 'concluido';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_evento'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS sem_acesso_por_tenant ON %I', t);
    -- USING (false): quem passa pelas policies (falatta_app) não enxerga nem
    -- grava nada. Só o dono da conexão (BYPASSRLS), usado pelo caminho de
    -- sistema do webhook, atravessa — e ainda precisa do privilégio de tabela.
    EXECUTE format(
      'CREATE POLICY sem_acesso_por_tenant ON %I USING (false) WITH CHECK (false)', t);
  END LOOP;
END
$$;

-- Desfaz o GRANT automático das ALTER DEFAULT PRIVILEGES da 001 (mesmo passo
-- da 015): sem isto a tabela nasceria acessível ao role de tenant.
REVOKE ALL ON webhook_evento FROM falatta_app;
REVOKE ALL ON SEQUENCE webhook_evento_id_seq FROM falatta_app;
