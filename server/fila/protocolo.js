// fila/protocolo.js — Protocolo de atendimento: YYMMDD + sequencial de 6 dígitos.
// Ex.: 260610100042. `seq_protocolo` é GLOBAL (compartilhada entre tenants) —
// decisão já tomada na fundação (FIL-58, migração 001_inicial.sql): o
// protocolo só precisa ser único POR TENANT (uq_conv_prot é UNIQUE(tenant_id,
// protocolo)), mas usar uma sequence global entrega unicidade mais forte de
// graça (dois tenants nunca colidem, mesmo gerando no mesmo instante), sem
// custo — nextval() é atômico independente de qual comTenant()/transação
// chama. Sequence não é sujeita a RLS, então gerarProtocolo funciona com
// qualquer `conn` (dentro ou fora de comTenant()).
'use strict';

async function gerarProtocolo(conn) {
  const r = await conn.execute(
    `SELECT to_char(now(), 'YYMMDD') || lpad(nextval('seq_protocolo')::text, 6, '0') AS p`
  );
  return r.rows[0].P;
}

module.exports = { gerarProtocolo };
