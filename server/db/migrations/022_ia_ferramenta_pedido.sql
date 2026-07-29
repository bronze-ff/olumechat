-- ============================================================================
-- 022_ia_ferramenta_pedido.sql — FIL-85: a IA que AGE.
--
-- Até aqui a IA respondia e transferia. Estas tabelas dão a ela três ações
-- dentro da conversa (preencher a ficha do contato, aplicar tag e registrar
-- pedido) e dão ao ADMIN o controle sobre elas:
--
--   ia_ferramenta       — liga/desliga POR EMPRESA. O catálogo (schema +
--     execução) vive no CÓDIGO (server/ia/operacoes.js); o banco só guarda o
--     interruptor. Sem linha nenhuma vale o default do catálogo — por isso a
--     migração NÃO faz seed: `atualizar_ficha_contato` e `aplicar_tag` nascem
--     ligadas (são inofensivas: escrevem no cadastro que o atendente já edita),
--     e `registrar_pedido` nasce DESLIGADA — só faz sentido depois que o admin
--     configurou o template e conheceu a tela de conferência.
--
--   ia_pedido_template  — 1 template por empresa (v1). `campos` jsonb com a
--     lista de { nome, rotulo, tipo, obrigatorio, opcoes? }. jsonb em vez de
--     tabela filha pelo mesmo motivo da ficha da 020: a forma do formulário
--     muda por empresa e não pode virar migração nova a cada campo. Quem valida
--     é a aplicação (server/ia/pedidoTemplate.js).
--
--   ia_pedido           — o registro que a IA cria e o atendente confere. O
--     `payload` guarda o RÓTULO junto do valor de cada campo: o template editado
--     seis meses depois não pode reescrever o que estava escrito num pedido
--     antigo. `titulo` é a mesma cópia, no nível do pedido.
--
-- Mais uma coisa entra aqui, e é dívida da FIL-84: o índice ÚNICO de
-- `ia_turno (tenant_id, conversa_id, numero_turno)`. O `salvar` do histórico
-- fazia MAX+1 lido antes do INSERT — duas mensagens no mesmo instante geram o
-- MESMO número de turno, e as ferramentas multiplicam turnos por mensagem. Com
-- o índice, o INSERT usa ON CONFLICT DO NOTHING + retry curto (ver
-- server/ia/historico.js) e a corrida deixa de existir. As duplicatas que já
-- existirem são RENUMERADAS antes (preservando a ordem de leitura, que é
-- (numero_turno, id)) — apagar turno seria apagar histórico de conversa.
--
-- ⚠️ AS TRÊS TABELAS ENTRAM NO BLOCO DE RLS `isolamento_tenant` (padrão das
-- migrações 013/016/017/020). Tabela nova fora dele fica sem isolamento entre
-- empresas, silenciosamente — e aqui trafega ficha de cliente e pedido.
--
-- IDEMPOTENTE DE VERDADE: `scripts/migrar.js` reaplica TODO o histórico a cada
-- deploy. Só CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS + CREATE POLICY,
-- GRANT e o bloco de renumeração — que é guardado por "existe duplicata?" e
-- portanto não faz nada da segunda vez em diante. Nunca edite este arquivo
-- depois de aplicado — mudança de schema é migração nova.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ia_ferramenta — interruptor por empresa. Sem seed (ver cabeçalho).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ia_ferramenta (
  tenant_id     bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  nome          varchar(60) NOT NULL,
  ativo         char(1) NOT NULL DEFAULT 'S',
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_ia_ferramenta       PRIMARY KEY (tenant_id, nome),
  CONSTRAINT ck_ia_ferramenta_ativo CHECK (ativo IN ('S', 'N'))
);

-- ----------------------------------------------------------------------------
-- 2. ia_pedido_template — um por empresa na v1 (tenant_id É a chave).
-- `atualizado_por` NULL é permitido de propósito: a sessão de suporte do
-- operador não é funcionário do cliente e não tem atendente_id (auth/rbac.js::
-- PERFIL_SUPORTE) — MATCH SIMPLE não checa a FK quando alguma coluna é NULL.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ia_pedido_template (
  tenant_id      bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  titulo         varchar(80) NOT NULL,
  campos         jsonb NOT NULL DEFAULT '[]'::jsonb,
  atualizado_por bigint,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_ia_pedido_template PRIMARY KEY (tenant_id),
  CONSTRAINT fk_ia_pedido_template_atendente FOREIGN KEY (tenant_id, atualizado_por)
    REFERENCES atendente (tenant_id, id)
);

-- ----------------------------------------------------------------------------
-- 3. ia_pedido — o que a IA registrou e o atendente confere.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ia_pedido (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id     bigint NOT NULL DEFAULT tenant_atual() REFERENCES tenant (id),
  conversa_id   bigint NOT NULL,
  contato_id    bigint,
  titulo        varchar(80),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        varchar(12) NOT NULL DEFAULT 'rascunho',
  observacao    varchar(500),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  conferido_por bigint,
  conferido_em  timestamptz,
  CONSTRAINT pk_ia_pedido        PRIMARY KEY (id),
  CONSTRAINT uq_ia_pedido        UNIQUE (tenant_id, id),
  CONSTRAINT ck_ia_pedido_status CHECK (status IN ('rascunho', 'conferido', 'descartado')),
  CONSTRAINT fk_ia_pedido_conv    FOREIGN KEY (tenant_id, conversa_id) REFERENCES conversa (tenant_id, id),
  CONSTRAINT fk_ia_pedido_contato FOREIGN KEY (tenant_id, contato_id)  REFERENCES contato (tenant_id, id),
  CONSTRAINT fk_ia_pedido_atd     FOREIGN KEY (tenant_id, conferido_por) REFERENCES atendente (tenant_id, id)
);

-- Leitura quente da tela do atendente: rascunhos do tenant, mais novos primeiro.
CREATE INDEX IF NOT EXISTS ix_ia_pedido_status   ON ia_pedido (tenant_id, status, criado_em DESC);
-- Badge da conversa (tem pedido em rascunho?).
CREATE INDEX IF NOT EXISTS ix_ia_pedido_conversa ON ia_pedido (tenant_id, conversa_id);

-- ----------------------------------------------------------------------------
-- 4. ia_turno: número de turno único por conversa (dívida da FIL-84)
--
-- Passo 1 — renumerar duplicatas EXISTENTES, se houver. Só as conversas
-- afetadas, e preservando a ordem em que o histórico já era lido
-- (numero_turno, id): reordenar a conversa inteira mudaria o que o provedor
-- recebe. Guardado pelo IF: na segunda execução não há duplicata e o bloco
-- inteiro não faz nada.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ia_turno
     WHERE numero_turno IS NOT NULL
     GROUP BY tenant_id, conversa_id, numero_turno
    HAVING count(*) > 1
  ) THEN
    WITH conversas_afetadas AS (
      SELECT tenant_id, conversa_id
        FROM ia_turno
       WHERE numero_turno IS NOT NULL
       GROUP BY tenant_id, conversa_id, numero_turno
      HAVING count(*) > 1
    ),
    renumerado AS (
      SELECT t.id,
             row_number() OVER (PARTITION BY t.tenant_id, t.conversa_id
                                ORDER BY t.numero_turno NULLS LAST, t.id) AS n
        FROM ia_turno t
        JOIN (SELECT DISTINCT tenant_id, conversa_id FROM conversas_afetadas) c
          ON c.tenant_id = t.tenant_id AND c.conversa_id = t.conversa_id
    )
    UPDATE ia_turno t
       SET numero_turno = r.n
      FROM renumerado r
     WHERE r.id = t.id
       AND t.numero_turno IS DISTINCT FROM r.n;
  END IF;
END
$$;

-- Passo 2 — o índice que faz o ON CONFLICT do ia/historico.js funcionar.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ia_turno_numero
  ON ia_turno (tenant_id, conversa_id, numero_turno);

-- ----------------------------------------------------------------------------
-- 5. RLS — mesmo bloco `isolamento_tenant` das demais tabelas de tenant.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ia_ferramenta', 'ia_pedido_template', 'ia_pedido'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS isolamento_tenant ON %I', t);
    EXECUTE format(
      'CREATE POLICY isolamento_tenant ON %I '
      || 'USING (tenant_id = tenant_atual()) '
      || 'WITH CHECK (tenant_id = tenant_atual())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ia_ferramenta      TO falatta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ia_pedido_template TO falatta_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ia_pedido          TO falatta_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public      TO falatta_app;
