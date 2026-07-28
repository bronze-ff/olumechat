-- 014_backfill_ia_habilitada.sql
-- A 011 criou tenant.ia_habilitada com DEFAULT 'N' — que também se aplicou,
-- retroativamente, a tenants que JÁ tinham uma integração de IA ativa
-- (ia_config.ativo = 'S') antes do add-on virar plano formal. O runtime do
-- bot (ia/runtime.js) e a rota de sugestão de resposta (api/conversas.js)
-- cortam na hora com o flag em 'N', e o client esconde a tela — a integração
-- existente morre até o operador religar manualmente.
--
-- A 011 JÁ FOI APLICADA em produção — não editamos migração aplicada (ver
-- WORKFLOW.md §6). Esta é a correção, em cima.
--
-- IDEMPOTENTE DE VERDADE (não só "não erra ao rodar de novo"): scripts/migrar.js
-- reaplica TODO o histórico a cada deploy, sem tabela de controle. Um UPDATE
-- baseado só em "ia_habilitada = 'N' e tem ia_config ativa" reacenderia o flag
-- pra sempre, mesmo depois de um operador desligar o add-on de propósito
-- (definirIa NÃO apaga ia_config — só corta o runtime, ver operador/tenants.js).
-- Por isso o backfill só alcança tenant que NUNCA teve uma decisão explícita
-- do operador sobre este flag (sem linha 'ia_habilitada'/'ia_desabilitada' em
-- operador_auditoria) — assim que o operador agir uma vez, em qualquer
-- direção, o tenant sai do escopo deste backfill para sempre.
UPDATE tenant t
   SET ia_habilitada = 'S'
 WHERE t.ia_habilitada = 'N'
   AND EXISTS (
     SELECT 1 FROM ia_config ic
      WHERE ic.tenant_id = t.id AND ic.ativo = 'S'
   )
   AND NOT EXISTS (
     SELECT 1 FROM operador_auditoria oa
      WHERE oa.tenant_id = t.id
        AND oa.acao IN ('ia_habilitada', 'ia_desabilitada')
   );
