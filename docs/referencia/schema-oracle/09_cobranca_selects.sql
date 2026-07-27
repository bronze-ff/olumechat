-- ============================================================================
-- MC-ZAP — FASE 6: GRANTs + SELECTs de exemplo para a Campanha de Cobrança.
--
-- ESTE ARQUIVO TEM DUAS PARTES:
--   (A) GRANTs/sinônimos — RODAR como MCCANAL (ou DBA). É o que precisa executar.
--   (B) SELECTs de exemplo — NÃO são migração. São modelos para COLAR no campo
--       "SELECT do segmento" da tela Admin > Campanhas. Você (DBA) ajusta os
--       nomes de coluna reais e valida com o botão "Pré-visualizar" (que mostra
--       o erro ORA cru se faltar GRANT ou se um nome estiver errado).
--
-- REGRA DO SEGMENTO: o SELECT precisa devolver UMA coluna de telefone (com DDD;
-- o sistema normaliza o 9º dígito) + as colunas que viram {{1}},{{2}}... do
-- template. Uma LINHA por cliente (agregue os títulos) p/ não mandar msg repetida.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- (A) GRANTs — rodar conectado como MCCANAL (dono das tabelas) ou DBA.
--     PCCLIENT e PCPREST já estão concedidos (confirme). PCHISTCOB/PCHISTCOBI
--     só são necessárias se você for usar a fonte "histórico de cobrança".
-- ─────────────────────────────────────────────────────────────────────────
-- GRANT SELECT ON MCCANAL.PCCLIENT   TO MCLABS;   -- (confirmar — já concedido)
-- GRANT SELECT ON MCCANAL.PCPREST    TO MCLABS;   -- (confirmar — já concedido)
GRANT SELECT ON MCCANAL.PCHISTCOB  TO MCLABS;
GRANT SELECT ON MCCANAL.PCHISTCOBI TO MCLABS;

-- Sinônimos (opcional — deixa o SELECT mais curto: PCPREST em vez de MCCANAL.PCPREST).
CREATE OR REPLACE SYNONYM MCLABS.PCCLIENT   FOR MCCANAL.PCCLIENT;
CREATE OR REPLACE SYNONYM MCLABS.PCPREST    FOR MCCANAL.PCPREST;
CREATE OR REPLACE SYNONYM MCLABS.PCHISTCOB  FOR MCCANAL.PCHISTCOB;
CREATE OR REPLACE SYNONYM MCLABS.PCHISTCOBI FOR MCCANAL.PCHISTCOBI;


-- ═════════════════════════════════════════════════════════════════════════
-- (B.1) FONTE RECOMENDADA — PCPREST (títulos EM ABERTO agora).
--   "Quem deve hoje". Re-consulta o WinThor a cada disparo → quem pagou sai
--   da lista sozinho. Ideal p/ re-disparo manual (sem cobrar quem já quitou).
--
--   Mapeamento sugerido do template:
--     {{1}} = nome   {{2}} = qtd   {{3}} = total   {{4}} = venc_antigo
--   Coluna do telefone: telefone
--   PCCLIENT (estrutura real): NÃO existe TELCEL. Os telefones são TELCELENT
--   (celular), TELCOB (cobrança), TELCOM (comercial), TELENT (entrega). Como o
--   WhatsApp só funciona em CELULAR, priorizamos TELCELENT e caímos p/ TELCOB.
-- ─────────────────────────────────────────────────────────────────────────
SELECT
       COALESCE(c.TELCELENT, c.TELCOB, c.TELCOM, c.TELENT)  telefone,   -- celular primeiro (WhatsApp)
       c.CLIENTE                                             nome,
       COUNT(*)                                              qtd,
       TO_CHAR(SUM(p.VALOR), 'FM999G999G990D00')             total,
       TO_CHAR(MIN(p.DTVENC), 'DD/MM/YYYY')                  venc_antigo
  FROM MCCANAL.PCPREST  p
  JOIN MCCANAL.PCCLIENT c ON c.CODCLI = p.CODCLI
 WHERE p.DTPAG IS NULL                       -- ainda não pago
   AND p.DTVENC < TRUNC(SYSDATE)             -- já vencido
   -- AND p.CODFILIAL = 1                    -- (opcional) só uma filial
 GROUP BY COALESCE(c.TELCELENT, c.TELCOB, c.TELCOM, c.TELENT), c.CLIENTE
HAVING COALESCE(c.TELCELENT, c.TELCOB, c.TELCOM, c.TELENT) IS NOT NULL;  -- só quem tem telefone


-- ═════════════════════════════════════════════════════════════════════════
-- (B.2) FONTE ALTERNATIVA — PCHISTCOB + PCHISTCOBI (régua/histórico de cobrança).
--   Use se quiser disparar a partir dos registros de cobrança JÁ LANÇADOS
--   (com o telefone TELCOB do próprio histórico) em vez dos títulos em aberto.
--   Estrutura confirmada (CSV enviado):
--     PCHISTCOB  (cabeçalho): CODCLI, TELCOB, NUMREGCOB, DATA, CODSTATUSCOB...
--     PCHISTCOBI (itens):     NUMREGCOB, DUPLIC, PREST, VALOR, DTVENC, ATRASO...
--   Join: PCHISTCOBI.NUMREGCOB = PCHISTCOB.NUMREGCOB
--
--   ATENÇÃO: PCHISTCOB é um LOG de contatos de cobrança; pode ter vários
--   registros por cliente. O filtro de CODSTATUSCOB / DATA evita ressuscitar
--   cobranças antigas. Para "saldo devedor atual", prefira a (B.1).
-- ─────────────────────────────────────────────────────────────────────────
SELECT
       h.TELCOB                                              telefone,
       cli.CLIENTE                                           nome,
       COUNT(*)                                              qtd,
       TO_CHAR(SUM(i.VALOR), 'FM999G999G990D00')             total,
       TO_CHAR(MIN(i.DTVENC), 'DD/MM/YYYY')                  venc_antigo
  FROM MCCANAL.PCHISTCOB  h
  JOIN MCCANAL.PCHISTCOBI i   ON i.NUMREGCOB = h.NUMREGCOB
  JOIN MCCANAL.PCCLIENT   cli ON cli.CODCLI  = h.CODCLI
 WHERE h.TELCOB IS NOT NULL
   AND i.DTVENC < TRUNC(SYSDATE)
   -- AND h.CODSTATUSCOB = 'P'               -- (opcional) só cobranças pendentes
   -- AND h.DATA >= TRUNC(SYSDATE) - 30      -- (opcional) só lançadas no último mês
 GROUP BY h.TELCOB, cli.CLIENTE;


-- ─────────────────────────────────────────────────────────────────────────
-- DICAS:
--  • O telefone pode vir com ou sem o 9º dígito — o sistema casa as duas formas.
--  • TELEFONE SEM DDD: o sistema só aceita número com DDD (10-11 dígitos) ou
--    DDI completo. Se o WinThor guarda só "98342-3192" / "3373-1061" (8-9 díg),
--    o "Preparar" pula como inválido. Complete o DDD no próprio SELECT:
--      CASE WHEN LENGTH(REGEXP_REPLACE(c.TELCELENT,'[^0-9]','')) <= 9
--           THEN '62' || REGEXP_REPLACE(c.TELCELENT,'[^0-9]','')   -- DDD da praça
--           ELSE REGEXP_REPLACE(c.TELCELENT,'[^0-9]','') END  AS telefone
--    (se houver clientes de outros DDDs, use a coluna de praça/cidade p/ decidir).
--  • Telefone FIXO não recebe WhatsApp — o disparo marca 'falha' nesses. Se puder,
--    filtre só celulares: dígito após o DDD = 9 (11 díg) ou 6-9 (8-9 díg antigos).
--  • Teste SEMPRE com "Pré-visualizar" antes de "Preparar"/"Disparar".
--  • Para um teste real, restrinja a 1-2 telefones seus:
--      ... WHERE ... AND c.CODCLI IN (123, 456)
--  • O template precisa ter a MESMA quantidade de {{n}} que você mapear.
-- ─────────────────────────────────────────────────────────────────────────
