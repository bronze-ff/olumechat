-- ============================================================================
-- 019_fatura.sql — FIL-79: faturamento mensal, pagamentos e inadimplência.
-- Fecha o ciclo financeiro com contrato (018/FIL-76) e consumo (016/FIL-77):
-- gera a fatura do mês, acompanha pagamento, age sobre inadimplência.
--
-- TRÊS TABELAS:
--
--   fatura       — uma por tenant POR COMPETÊNCIA (UNIQUE tenant_id+competencia
--     é o que torna a geração mensal IDEMPOTENTE: rodar duas vezes para a
--     mesma competência não duplica — o segundo INSERT bate no ON CONFLICT DO
--     NOTHING em server/financeiro/faturamento.js::gerarFaturas).
--
--   fatura_item  — CONGELA o que compôs a fatura: descrição, tipo, quantidade,
--     valor unitário, total. Gravado uma única vez na geração (ou, enquanto a
--     fatura ainda está `prevista`, por ajuste manual do operador — ver
--     server/operador/fatura.js). NUNCA recalculado a partir de contrato ou
--     consumo depois — mudar o contrato depois NÃO muda fatura já gerada,
--     mesma fechada que já é `emitida`. É esse o contrato do domínio.
--
--   pagamento    — registro manual (sem gateway — fora de escopo do ticket).
--     Pagamento parcial mantém a fatura aberta com saldo; total fecha
--     (`status = 'paga'`) — ver operador/fatura.js::registrarPagamento.
--
-- `fatura.custo_incerto`: sinaliza que o consumo medido do período (FIL-77)
-- tem evento(s) com `custo_centavos IS NULL` (preço do modelo ainda não
-- cadastrado pelo operador em preco_provedor). A fatura NUNCA assume esse
-- custo como zero silenciosamente — o valor gerado é só a soma do que é
-- CONHECIDO, e esta flag pede revisão do operador antes de `emitir` (ver
-- cabeçalho de server/financeiro/faturamento.js).
--
-- ⚠️ TABELAS FECHADAS PARA O CAMINHO DE TENANT — MESMO PADRÃO de `contrato`
-- (018) / `provedor_credencial` (015): RLS ENABLE+FORCE com policy USING(false)
-- e REVOKE ALL de falatta_app. O cliente NUNCA vê fatura, item ou pagamento —
-- nem rota, nem tela (ver docs/SEGURANCA.md). Só o caminho de operador
-- (operador/db.js::comOperador, BYPASSRLS) atravessa.
--
-- IDEMPOTENTE: pode rodar mais de uma vez. Nunca edite este arquivo depois de
-- aplicado em um ambiente compartilhado — mudança de schema é migração nova.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- fatura — uma linha por tenant+competência. Valores SEMPRE em centavos
-- (bigint), nunca float.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fatura (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id             bigint NOT NULL REFERENCES tenant (id),
  competencia           varchar(7) NOT NULL, -- 'YYYY-MM'
  vencimento            date NOT NULL,
  valor_total_centavos  bigint NOT NULL DEFAULT 0 CHECK (valor_total_centavos >= 0),
  status                varchar(20) NOT NULL DEFAULT 'prevista',
  -- Consumo do período com custo desconhecido (NULL) em algum evento — ver
  -- cabeçalho. Nunca vira "0" silencioso; o operador revisa antes de emitir.
  custo_incerto         boolean NOT NULL DEFAULT false,
  emitida_em            timestamptz,
  paga_em               timestamptz,
  observacoes           text,
  criado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fatura_tenant_competencia UNIQUE (tenant_id, competencia),
  CONSTRAINT ck_fatura_competencia CHECK (competencia ~ '^\d{4}-\d{2}$'),
  CONSTRAINT ck_fatura_status CHECK (status IN ('prevista','emitida','paga','atrasada','cancelada','em_negociacao'))
);

CREATE INDEX IF NOT EXISTS ix_fatura_tenant ON fatura (tenant_id, competencia DESC);
CREATE INDEX IF NOT EXISTS ix_fatura_status_venc ON fatura (status, vencimento);

-- ----------------------------------------------------------------------------
-- fatura_item — linhas congeladas da fatura. `origem_tipo`/`origem_id`
-- rastreiam de onde veio o item (contrato_item ou implementacao) SÓ para
-- permitir a geração seguinte saber "o que já foi cobrado" (ex.: contar
-- parcelas de implementação já faturadas) — não é usado para recalcular nada
-- em fatura já existente.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fatura_item (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fatura_id                bigint NOT NULL REFERENCES fatura (id),
  tipo                     varchar(30) NOT NULL,
  descricao                varchar(200) NOT NULL,
  quantidade               bigint NOT NULL DEFAULT 1,
  valor_unitario_centavos  bigint NOT NULL,
  valor_total_centavos     bigint NOT NULL,
  origem_tipo              varchar(30),
  origem_id                bigint,
  criado_em                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_faturaitem_tipo CHECK (
    tipo IN ('recorrencia','implementacao','addon_ia','numero_extra','excedente_mensagem','desconto','avulso','excedente')
  ),
  CONSTRAINT ck_faturaitem_qtd   CHECK (quantidade > 0),
  CONSTRAINT ck_faturaitem_valor CHECK (
    (tipo = 'desconto' AND valor_unitario_centavos <= 0) OR
    (tipo <> 'desconto' AND valor_unitario_centavos >= 0)
  ),
  CONSTRAINT ck_faturaitem_total CHECK (valor_total_centavos = quantidade * valor_unitario_centavos)
);

CREATE INDEX IF NOT EXISTS ix_faturaitem_fatura ON fatura_item (fatura_id);
-- Conta quantas parcelas de UMA implementação já foram faturadas (qualquer
-- tenant/fatura) — ver server/financeiro/faturamento.js::proximaParcela.
CREATE INDEX IF NOT EXISTS ix_faturaitem_origem ON fatura_item (origem_tipo, origem_id) WHERE origem_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- pagamento — registro manual (fora de escopo: gateway/NF). Vários pagamentos
-- por fatura (parcial mantém saldo; a soma bate o total fecha a fatura).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagamento (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fatura_id       bigint NOT NULL REFERENCES fatura (id),
  valor_centavos  bigint NOT NULL CHECK (valor_centavos > 0),
  data_pagamento  date NOT NULL,
  meio            varchar(20) NOT NULL,
  comprovante     text,
  registrado_por  bigint NOT NULL REFERENCES operador (id),
  criado_em       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_pagamento_meio CHECK (meio IN ('pix','boleto','transferencia','cartao'))
);

CREATE INDEX IF NOT EXISTS ix_pagamento_fatura ON pagamento (fatura_id);

-- ============================================================================
-- FECHAMENTO PARA O CAMINHO DE TENANT (ver ⚠️ no cabeçalho).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fatura', 'fatura_item', 'pagamento'] LOOP
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
REVOKE ALL ON fatura, fatura_item, pagamento FROM falatta_app;
REVOKE ALL ON SEQUENCE fatura_id_seq, fatura_item_id_seq, pagamento_id_seq FROM falatta_app;
