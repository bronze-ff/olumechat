// utils/clienteLookup.js — Ponto de extensão: telefone -> cliente no sistema do tenant.
//
// No Falatta cada tenant tem (ou não tem) um ERP/CRM próprio. Este módulo é o SEAM
// onde essa integração entra: o núcleo do produto chama estas funções na chegada da
// mensagem (webhook) e na ficha do contato, e segue normalmente quando elas devolvem
// null — identificar o cliente é SEMPRE best-effort e nunca pode derrubar a ingestão.
//
// Implementação padrão: no-op (devolve null). O tenant que quiser auto-identificação
// registra um provedor com registrarProvedor().
//
// Contrato do provedor:
//   acharPorTelefone(telefone) -> { codigo, nome, documento } | null
//   dadosDoCliente(codigo)     -> objeto livre exibido na ficha | null
// Regra de ouro herdada da v1: em caso de AMBIGUIDADE, devolva null. Vincular o
// contato ao cliente errado é pior do que não vincular.
'use strict';

let provedor = null;

/** Registra o provedor de identificação do tenant (ou null pra desligar). */
function registrarProvedor(p) {
  provedor = p && typeof p === 'object' ? p : null;
}

/**
 * Quebra o E.164 em { last8, nat10, ddd } ou null se não der pra confiar.
 * Genérico p/ Brasil — imune ao 9º dígito e ao DDI 55. Fica no núcleo porque o
 * matching por final de número é útil pra qualquer provedor.
 */
function partesTelefone(e164) {
  let d = String(e164 || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); // tira o DDI 55
  if (d.length < 10) return null; // sem DDD confiável (não arrisca casar)
  const last8 = d.slice(-8);
  const ddd = d.slice(0, 2);
  return { last8, nat10: ddd + last8, ddd };
}

/** Acha o cliente do telefone. Sem provedor → null. Nunca lança. */
async function acharClientePorTelefone(_conn, telefone) {
  if (!provedor || typeof provedor.acharPorTelefone !== 'function') return null;
  try {
    return (await provedor.acharPorTelefone(telefone)) || null;
  } catch (err) {
    console.error('[clienteLookup] provedor falhou (seguindo sem vínculo):', err.message);
    return null;
  }
}

/** Dados extras do cliente pra ficha do contato. Sem provedor → null. Nunca lança. */
async function dadosClienteWinthor(_conn, codigo) {
  if (!codigo || !provedor || typeof provedor.dadosDoCliente !== 'function') return null;
  try {
    return (await provedor.dadosDoCliente(codigo)) || null;
  } catch (err) {
    console.error('[clienteLookup] provedor falhou na ficha (seguindo sem dados):', err.message);
    return null;
  }
}

module.exports = {
  acharClientePorTelefone,
  partesTelefone,
  dadosClienteWinthor, // TODO(falatta): renomear p/ dadosDoCliente junto com os call sites
  registrarProvedor,
};
