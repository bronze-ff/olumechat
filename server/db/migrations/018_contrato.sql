-- ============================================================================
-- 018_contrato.sql — FIL-76: contrato comercial por cliente (plano,
-- recorrência, implementação). Base do módulo financeiro: responde "quanto
-- esse cliente paga, desde quando, e pelo quê" — SÓ para o operador.
--
-- Decisão de produto: o operador vende uma IMPLEMENTAÇÃO (setup, à vista ou
-- parcelado) e uma RECORRÊNCIA mensal por plano. `inicio_cobranca` é separado
-- do início do uso porque alguns clientes ficam um tempo em implantação antes
-- de a cobrança começar (período de implantação/cortesia). O FIL-81
-- (onboarding Meta) tem um gancho que SUGERE esta data ao concluir a última
-- etapa — sem dependência de código aqui, só o campo pronto para receber.
--
-- TRÊS TABELAS:
--
--   contrato      — um por tenant POR VEZ (fim_vigencia IS NULL = o ativo).
--     Trocar de plano NUNCA sobrescreve: encerra o contrato atual
--     (fim_vigencia = hoje) e insere uma linha nova (server/operador/contrato.js
--     ::criarOuTrocarContrato). Histórico do que foi cobrado é imutável — não
--     há UPDATE de valor/plano num contrato já existente, só encerramento +
--     linha nova.
--
--   contrato_item — o que compõe a fatura além da recorrência (implementação,
--     add-on de IA, número extra, excedente de mensagem, desconto, avulso).
--     Preso a UM contrato (contrato_id); só pode ser adicionado/editado/
--     removido enquanto o contrato dono ainda está ativo — trocar de plano
--     "congela" os itens do contrato antigo junto com o resto do histórico.
--
--   implementacao — o projeto de entrada do cliente: valor, forma de
--     pagamento, status, datas. Vinculado ao tenant (não ao contrato — é o
--     projeto de implantação do CLIENTE, sobrevive a troca de plano depois).
--
-- ⚠️ TABELAS FECHADAS PARA O CAMINHO DE TENANT — MESMO PADRÃO de
-- `provedor_credencial` (015) / `preco_provedor` (016): RLS ENABLE+FORCE com
-- policy USING(false) e REVOKE ALL de falatta_app. O cliente NUNCA vê contrato
-- ou valor — nem rota, nem tela (ver docs/SEGURANCA.md) — e aqui isso vale
-- também em nível de banco: uma conexão de tenant (comTenant(), role
-- falatta_app) que tentasse ler recebe "permission denied", nunca uma linha.
-- Só o caminho de operador (operador/db.js::comOperador, BYPASSRLS) atravessa.
-- Diferente de `consumo_evento` (016), que é ESCRITA pelo runtime de tenant —
-- aqui a escrita é 100% do operador, então o fechamento total é o padrão certo
-- (nenhum caminho de tenant tem motivo legítimo para tocar estas tabelas).
--
-- IDEMPOTENTE: pode rodar mais de uma vez. Nunca edite este arquivo depois de
-- aplicado em um ambiente compartilhado — mudança de schema é migração nova.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- contrato — plano + recorrência vigente (ou já encerrada) de um tenant.
-- Valores SEMPRE em centavos (bigint), nunca float.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contrato (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id                  bigint NOT NULL REFERENCES tenant (id),
  plano_nome                 varchar(120) NOT NULL,
  valor_recorrente_centavos  bigint NOT NULL CHECK (valor_recorrente_centavos >= 0),
  ciclo                      varchar(20) NOT NULL,
  dia_vencimento             smallint NOT NULL,
  -- Pode ser depois do início do uso (implantação/cortesia) — nunca antes.
  inicio_cobranca            date NOT NULL,
  -- NULL = contrato ativo. Preenchido quando um contrato novo o substitui.
  fim_vigencia               date,
  reajuste_indice            varchar(20),
  reajuste_mes               smallint,
  observacoes                text,
  criado_por                 bigint NOT NULL REFERENCES operador (id),
  criado_em                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_contrato_ciclo    CHECK (ciclo IN ('mensal','trimestral','anual')),
  CONSTRAINT ck_contrato_venc     CHECK (dia_vencimento BETWEEN 1 AND 28),
  CONSTRAINT ck_contrato_reaj_mes CHECK (reajuste_mes IS NULL OR reajuste_mes BETWEEN 1 AND 12),
  CONSTRAINT ck_contrato_vigencia CHECK (fim_vigencia IS NULL OR fim_vigencia >= inicio_cobranca)
);

CREATE INDEX IF NOT EXISTS ix_contrato_tenant ON contrato (tenant_id, criado_em DESC);

-- Só um contrato ATIVO por tenant — é o que faz "trocar de plano" precisar
-- encerrar o anterior antes de o índice aceitar o novo.
CREATE UNIQUE INDEX IF NOT EXISTS ux_contrato_ativo_unico
  ON contrato (tenant_id) WHERE fim_vigencia IS NULL;

-- ----------------------------------------------------------------------------
-- contrato_item — linhas de fatura além da recorrência. `recorrente = false`
-- é item único (setup); `true` repete a cada ciclo do contrato dono.
-- Desconto é valor NEGATIVO (reduz a fatura); os demais tipos são >= 0.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contrato_item (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contrato_id              bigint NOT NULL REFERENCES contrato (id),
  tipo                     varchar(30) NOT NULL,
  descricao                varchar(200) NOT NULL,
  valor_unitario_centavos  bigint NOT NULL,
  quantidade               integer NOT NULL DEFAULT 1,
  recorrente               boolean NOT NULL DEFAULT false,
  criado_em                timestamptz NOT NULL DEFAULT now(),
  atualizado_em            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_contitem_tipo  CHECK (tipo IN ('implementacao','addon_ia','numero_extra','excedente_mensagem','desconto','avulso')),
  CONSTRAINT ck_contitem_qtd   CHECK (quantidade > 0),
  CONSTRAINT ck_contitem_valor CHECK (
    (tipo = 'desconto' AND valor_unitario_centavos <= 0) OR
    (tipo <> 'desconto' AND valor_unitario_centavos >= 0)
  )
);

CREATE INDEX IF NOT EXISTS ix_contitem_contrato ON contrato_item (contrato_id);

-- ----------------------------------------------------------------------------
-- implementacao — o projeto de entrada do cliente (setup). Ligado ao tenant,
-- não ao contrato: sobrevive a uma troca de plano posterior.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS implementacao (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         bigint NOT NULL REFERENCES tenant (id),
  valor_centavos    bigint NOT NULL CHECK (valor_centavos >= 0),
  forma_pagamento   varchar(20) NOT NULL,
  numero_parcelas   smallint,
  status            varchar(20) NOT NULL DEFAULT 'a_iniciar',
  data_prevista     date,
  data_entrega      date,
  responsavel       varchar(120),
  criado_por        bigint NOT NULL REFERENCES operador (id),
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_implant_forma  CHECK (forma_pagamento IN ('a_vista','parcelado')),
  CONSTRAINT ck_implant_status CHECK (status IN ('a_iniciar','em_andamento','entregue')),
  CONSTRAINT ck_implant_parc   CHECK (
    (forma_pagamento = 'parcelado' AND numero_parcelas >= 2) OR
    (forma_pagamento = 'a_vista' AND (numero_parcelas IS NULL OR numero_parcelas = 1))
  )
);

CREATE INDEX IF NOT EXISTS ix_implant_tenant ON implementacao (tenant_id, criado_em DESC);

-- ============================================================================
-- FECHAMENTO PARA O CAMINHO DE TENANT (ver ⚠️ no cabeçalho).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contrato', 'contrato_item', 'implementacao'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS sem_acesso_por_tenant ON %I', t);
    -- USING (false): quem passa pelas policies (falatta_app) não enxerga nem
    -- grava nada. Só o dono da conexão (BYPASSRLS), usado pelo caminho de
    -- operador, atravessa — e ele ainda precisa do privilégio de tabela.
    EXECUTE format(
      'CREATE POLICY sem_acesso_por_tenant ON %I USING (false) WITH CHECK (false)', t);
  END LOOP;
END
$$;

-- Desfaz o GRANT automático das ALTER DEFAULT PRIVILEGES da 001.
REVOKE ALL ON contrato, contrato_item, implementacao FROM falatta_app;
REVOKE ALL ON SEQUENCE contrato_id_seq, contrato_item_id_seq, implementacao_id_seq FROM falatta_app;
