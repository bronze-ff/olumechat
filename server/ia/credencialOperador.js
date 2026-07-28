// server/ia/credencialOperador.js — cifra/decifra a credencial GLOBAL do
// operador (FIL-78), usando o mesmo AES-256-GCM de ia/crypto.js.
//
// ia/crypto.js deriva a chave de cifragem por tenant_id (FIL-63, defesa em
// profundidade). A credencial do operador não pertence a tenant nenhum, mas
// em vez de mudar o contrato de crypto.js, reaproveitamos os parâmetros já
// existentes: um pseudo-id fixo (não é tenant_id de verdade, nunca colide com
// um id real porque não é numérico) + um CONTEXTO dedicado, diferente do
// 'ia_config' usado por tenant. Isso garante que o blob desta credencial
// nunca decifra com a chave de nenhum tenant real, e vice-versa — mesmo
// domínio de segurança do FIL-63, sem tocar em crypto.js.
'use strict';
const { criptografar, descriptografar } = require('./crypto');

const PSEUDO_ID = 'operador-global';
const CONTEXTO = 'provedor_credencial_operador';

const cifrar = (texto) => criptografar(texto, PSEUDO_ID, undefined, CONTEXTO);
const decifrar = (blob) => descriptografar(blob, PSEUDO_ID, undefined, CONTEXTO);

module.exports = { cifrar, decifrar };
