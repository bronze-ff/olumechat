-- ============================================================================
-- 14_contatos_duplicados.sql — acha e mescla contatos DUPLICADOS (mesmo cliente
-- virou 2 contatos por causa do 9º dígito, antes do fix de casamento).
-- Rode conectado como MCLABS no PL/SQL Developer (Command Window / F8) ou SQL Developer.
--
-- Por que importa: a ficha do contato (nome interno, CNPJ, CODCLI) mora no
-- CONTATO. Se a mesma pessoa existe em 2 linhas, o rótulo pode cair numa e a
-- mensagem futura casar na outra. Daqui pra frente o casamento é único; aqui a
-- gente limpa o legado.
--
-- A "chave" do mesmo telefone = DDD (2 díg após o 55) + os 8 últimos dígitos —
-- estável e imune ao 9º dígito.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PASSO 1 — DIAGNÓSTICO: grupos de contatos que são a MESMA pessoa.
-- Cada linha mostra um par/grupo (chave) e os IDs envolvidos. Escolha qual
-- MANTER (normalmente o que já tem CODCLI/NOME_INTERNO) e quais remover.
-- ----------------------------------------------------------------------------
WITH base AS (
  SELECT ID, TELEFONE, NOME_PERFIL, NOME_INTERNO, CODCLI,
         SUBSTR(REGEXP_REPLACE(TELEFONE,'[^0-9]',''), 3, 2)
         || SUBSTR(REGEXP_REPLACE(TELEFONE,'[^0-9]',''), -8) AS CHAVE,
         (SELECT COUNT(*) FROM MC_ZAP_CONVERSA c WHERE c.CONTATO_ID = ct.ID) AS QTD_CONVERSAS
    FROM MC_ZAP_CONTATO ct
   WHERE LENGTH(REGEXP_REPLACE(TELEFONE,'[^0-9]','')) >= 12
)
SELECT CHAVE,
       LISTAGG(ID || NVL2(CODCLI,'*','') , ', ') WITHIN GROUP (ORDER BY ID) AS IDS_CONTATO,
       COUNT(*) AS QTD,
       LISTAGG(TELEFONE, ' | ') WITHIN GROUP (ORDER BY ID) AS TELEFONES,
       SUM(QTD_CONVERSAS) AS TOTAL_CONVERSAS
  FROM base
 GROUP BY CHAVE
HAVING COUNT(*) > 1
 ORDER BY QTD DESC, CHAVE;
-- (ID com "*" = já tem CODCLI vinculado — bom candidato a MANTER.)

-- ----------------------------------------------------------------------------
-- PASSO 2 — MESCLAR um par. Edite :manter e :remover e rode o bloco.
-- Re-aponta conversas/mensagens/itens-de-campanha/auditoria do REMOVER para o
-- MANTER, copia CODCLI/CGCENT/NOME_INTERNO para o MANTER se estiver vazio, e
-- apaga o contato REMOVER. Tudo numa transação.
-- ----------------------------------------------------------------------------
DECLARE
  v_manter  CONSTANT NUMBER := 0;   -- <<< ID do contato que FICA
  v_remover CONSTANT NUMBER := 0;   -- <<< ID do contato duplicado que SAI
BEGIN
  IF v_manter = 0 OR v_remover = 0 OR v_manter = v_remover THEN
    DBMS_OUTPUT.PUT_LINE('Edite v_manter e v_remover (IDs diferentes, != 0).');
    RETURN;
  END IF;

  -- completa a ficha do que fica, sem sobrescrever o que já tem
  UPDATE MC_ZAP_CONTATO m
     SET m.CODCLI       = NVL(m.CODCLI,       (SELECT CODCLI       FROM MC_ZAP_CONTATO WHERE ID = v_remover)),
         m.CGCENT       = NVL(m.CGCENT,       (SELECT CGCENT       FROM MC_ZAP_CONTATO WHERE ID = v_remover)),
         m.NOME_INTERNO = NVL(m.NOME_INTERNO, (SELECT NOME_INTERNO FROM MC_ZAP_CONTATO WHERE ID = v_remover)),
         m.NOME_PERFIL  = NVL(m.NOME_PERFIL,  (SELECT NOME_PERFIL  FROM MC_ZAP_CONTATO WHERE ID = v_remover))
   WHERE m.ID = v_manter;

  -- re-aponta os filhos (FK CONTATO_ID) + a trilha de auditoria
  UPDATE MC_ZAP_CONVERSA      SET CONTATO_ID = v_manter WHERE CONTATO_ID = v_remover;
  UPDATE MC_ZAP_MENSAGEM      SET CONTATO_ID = v_manter WHERE CONTATO_ID = v_remover;
  UPDATE MC_ZAP_CAMPANHA_ITEM SET CONTATO_ID = v_manter WHERE CONTATO_ID = v_remover;
  UPDATE MC_ZAP_AUDITORIA     SET ENTIDADE_ID = v_manter WHERE ENTIDADE = 'contato' AND ENTIDADE_ID = v_remover;

  DELETE FROM MC_ZAP_CONTATO WHERE ID = v_remover;

  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Mesclado: contato ' || v_remover || ' -> ' || v_manter || '.');
END;
/
