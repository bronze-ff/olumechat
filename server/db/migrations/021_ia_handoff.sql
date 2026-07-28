-- ============================================================================
-- 021_ia_handoff.sql — FIL-84: autoria de mensagem e ativação da IA por canal.
--
-- QUATRO MUDANÇAS, todas em tabela que JÁ EXISTE (nenhuma tabela nova ⇒ nenhum
-- bloco de RLS novo; `mensagem`, `numero`, `ia_turno` e `consumo_*` já estão no
-- `isolamento_tenant` das migrações 001/016):
--
--   1. mensagem.origem — quem escreveu: cliente / atendente / ia / bot /
--      sistema. Até aqui o único sinal era `atendente_id IS NULL`, que vale
--      igual para o bot de fluxo, para a IA e para o aviso de fora-de-horário.
--      Sem esta coluna não existe UI de takeover (o atendente precisa ver o que
--      foi a IA que disse em nome da empresa). Backfill heurístico — não dá
--      para distinguir bot/ia/aviso retroativamente, e isso é aceito.
--
--   2. numero.ia_regra — 'sempre' (default) | 'fora_horario'. A fonte de
--      horário é o expediente JÁ configurado do tenant (config
--      fora_horario_ativo + horario_atendimento, ver server/utils/horario.js).
--      Zero config nova, de propósito.
--
--   3. numero.ia_modo_teste — a allowlist (`ia_autorizado`) vira um MODO. 'S' =
--      só telefones autorizados; 'N' = a IA atende qualquer cliente do canal.
--      ⚠️ NASCE LIGADO nos números que JÁ estão em modo='ia': um deploy não
--      pode abrir para todo mundo um número que hoje só atende a allowlist.
--      Abrir é ação explícita do admin. O backfill roda UMA VEZ, guardado pela
--      existência da coluna — senão o deploy seguinte religaria o modo teste
--      que o admin acabou de desligar.
--
--   4. ia_turno.midia_caminho/midia_mime — a IA passa a ver imagem e ouvir
--      áudio. O turno guarda o CAMINHO no storage, nunca os bytes (o reanexo é
--      limitado às 2 imagens mais recentes por turno — ver server/ia/anexos.js;
--      sem esse teto, cada turno reenviaria todas as imagens da conversa ao
--      provedor). E `ia_audio_seg` entra nos CHECKs de consumo, senão o INSERT
--      do STT é rejeitado pela constraint: o custo de transcrição é medido em
--      SEGUNDOS, unidade diferente de token — de propósito NÃO conta no teto de
--      tokens do FIL-78 na v1.
--
-- IDEMPOTENTE DE VERDADE: `scripts/migrar.js` reaplica TODO o histórico a cada
-- deploy, cada arquivo numa transação. Os dois UPDATEs desta migração são de
-- backfill e só rodam uma vez (um pelo `WHERE origem IS NULL`, o outro pela
-- guarda de existência da coluna). Nunca edite este arquivo depois de aplicado
-- — mudança de schema é migração nova.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. mensagem.origem
-- ----------------------------------------------------------------------------
ALTER TABLE mensagem ADD COLUMN IF NOT EXISTS origem varchar(10);

-- Backfill heurístico. Só linha ainda NULL — reexecutar não mexe em nada.
UPDATE mensagem
   SET origem = CASE
                  WHEN direcao = 'in'           THEN 'cliente'
                  WHEN atendente_id IS NOT NULL THEN 'atendente'
                  ELSE 'sistema'
                END
 WHERE origem IS NULL;

-- DEFAULT conservador: um caminho de envio que ainda não foi atualizado grava
-- 'sistema' em vez de estourar o NOT NULL em produção.
ALTER TABLE mensagem ALTER COLUMN origem SET DEFAULT 'sistema';
ALTER TABLE mensagem ALTER COLUMN origem SET NOT NULL;

ALTER TABLE mensagem DROP CONSTRAINT IF EXISTS ck_msg_origem;
ALTER TABLE mensagem ADD  CONSTRAINT ck_msg_origem
  CHECK (origem IN ('cliente','atendente','ia','bot','sistema'));

-- Timeline do atendente destaca a fala da IA dentro de uma conversa.
CREATE INDEX IF NOT EXISTS ix_msg_conv_origem ON mensagem (tenant_id, conversa_id, origem);

-- ----------------------------------------------------------------------------
-- 2. numero.ia_regra
-- ----------------------------------------------------------------------------
ALTER TABLE numero ADD COLUMN IF NOT EXISTS ia_regra varchar(12) NOT NULL DEFAULT 'sempre';

ALTER TABLE numero DROP CONSTRAINT IF EXISTS ck_num_ia_regra;
ALTER TABLE numero ADD  CONSTRAINT ck_num_ia_regra
  CHECK (ia_regra IN ('sempre','fora_horario'));

-- ----------------------------------------------------------------------------
-- 3. numero.ia_modo_teste — backfill guardado (roda UMA vez, nunca regride)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'numero' AND column_name = 'ia_modo_teste'
  ) THEN
    -- Número NOVO nasce aberto ('N'); número que JÁ ESTAVA em modo='ia' nasce
    -- fechado ('S'), preservando exatamente o comportamento de hoje.
    ALTER TABLE numero ADD COLUMN ia_modo_teste char(1) NOT NULL DEFAULT 'N';
    UPDATE numero SET ia_modo_teste = 'S' WHERE modo = 'ia';
  END IF;
END
$$;

ALTER TABLE numero DROP CONSTRAINT IF EXISTS ck_num_ia_modo_teste;
ALTER TABLE numero ADD  CONSTRAINT ck_num_ia_modo_teste
  CHECK (ia_modo_teste IN ('S','N'));

-- ----------------------------------------------------------------------------
-- 4. Mídia no turno da IA + tipo de consumo do STT
-- ----------------------------------------------------------------------------
ALTER TABLE ia_turno ADD COLUMN IF NOT EXISTS midia_caminho varchar(500);
ALTER TABLE ia_turno ADD COLUMN IF NOT EXISTS midia_mime    varchar(120);

ALTER TABLE consumo_evento DROP CONSTRAINT IF EXISTS ck_consevt_tipo;
ALTER TABLE consumo_evento ADD  CONSTRAINT ck_consevt_tipo
  CHECK (tipo IN ('ia_tokens','mensagem_enviada','conversa_iniciada','midia_armazenada','ia_audio_seg'));

ALTER TABLE consumo_mensal DROP CONSTRAINT IF EXISTS ck_consmensal_tipo;
ALTER TABLE consumo_mensal ADD  CONSTRAINT ck_consmensal_tipo
  CHECK (tipo IN ('ia_tokens','mensagem_enviada','conversa_iniciada','midia_armazenada','ia_audio_seg'));
