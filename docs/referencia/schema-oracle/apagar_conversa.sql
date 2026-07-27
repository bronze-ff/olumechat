-- ============================================================================
-- apagar_conversa.sql — apaga UMA conversa (e tudo que depende dela).
-- Rode conectado como MCLABS no PL/SQL Developer (Command Window, ou SQL Window
-- com F8) ou no SQL Developer (F5).
--
-- POR QUE O DELETE DIRETO FALHA (ORA-02292):
--   MC_ZAP_MENSAGEM aponta para MC_ZAP_CONVERSA (FK_MCZAP_MSG_CONV). O Oracle
--   não deixa apagar o "pai" (conversa) enquanto houver "filhos" (mensagens).
--   Não existe ON DELETE CASCADE — é proposital: mensagem é histórico permanente.
--   Por isso apagamos os filhos ANTES, nesta ordem:
--     1) MC_ZAP_MENSAGEM   (mensagens/notas/mídia)      -- FK obrigatória
--     2) MC_ZAP_AUDITORIA  (trilha ENTIDADE='conversa') -- sem FK, só limpeza
--     3) MC_ZAP_CONVERSA   (a conversa em si)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PASSO 1 — PREVIEW (não altera nada): troque o protocolo e veja o que sairia.
-- ----------------------------------------------------------------------------
SELECT c.ID AS CONVERSA_ID, c.PROTOCOLO, c.STATUS, c.FILA_STATUS,
       (SELECT COUNT(*) FROM MC_ZAP_MENSAGEM  m WHERE m.CONVERSA_ID = c.ID) AS MENSAGENS,
       (SELECT COUNT(*) FROM MC_ZAP_AUDITORIA a WHERE a.ENTIDADE = 'conversa' AND a.ENTIDADE_ID = c.ID) AS AUDITORIAS
  FROM MC_ZAP_CONVERSA c
 WHERE c.PROTOCOLO = '260614100008';   -- <<< EDITE o protocolo aqui

-- ----------------------------------------------------------------------------
-- PASSO 2 — EXCLUSÃO atômica. Edite o protocolo em UM lugar (v_prot) e rode.
--   Para apagar por ID em vez de protocolo, comente a linha do SELECT ... INTO
--   e use:  v_id := 123;
-- ----------------------------------------------------------------------------
DECLARE
  v_prot CONSTANT VARCHAR2(14) := '260614100008';   -- <<< EDITE o protocolo aqui
  v_id   MC_ZAP_CONVERSA.ID%TYPE;
  v_msgs NUMBER := 0;
  v_auds NUMBER := 0;
BEGIN
  SELECT ID INTO v_id FROM MC_ZAP_CONVERSA WHERE PROTOCOLO = v_prot;

  DELETE FROM MC_ZAP_MENSAGEM  WHERE CONVERSA_ID = v_id;                              v_msgs := SQL%ROWCOUNT;
  DELETE FROM MC_ZAP_AUDITORIA WHERE ENTIDADE = 'conversa' AND ENTIDADE_ID = v_id;    v_auds := SQL%ROWCOUNT;
  DELETE FROM MC_ZAP_CONVERSA  WHERE ID = v_id;

  COMMIT;
  DBMS_OUTPUT.PUT_LINE('OK: conversa '||v_id||' ('||v_prot||') apagada — '
    ||v_msgs||' mensagem(ns) e '||v_auds||' auditoria(s).');
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    DBMS_OUTPUT.PUT_LINE('Protocolo '||v_prot||' nao encontrado. Nada foi apagado.');
END;
/
