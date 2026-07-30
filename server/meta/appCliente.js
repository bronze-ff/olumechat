// meta/appCliente.js — o app da META DO PRÓPRIO CLIENTE (FIL-97).
//
// Dois modelos de conexão convivem neste sistema, de propósito:
//
//   PLATAFORMA (destino final) — app único da Olume, Embedded Signup,
//     `META_APP_SECRET` global validando o webhook de todo mundo em `/webhook`.
//   APP POR CLIENTE (este arquivo) — enquanto a Olume não tem CNPJ (e portanto
//     não tem app verificado), cada cliente usa o app DELE: App ID + App Secret
//     próprios, guardados aqui, e uma URL de webhook exclusiva.
//
// ── POR QUE UMA URL POR CLIENTE ────────────────────────────────────────────
// A assinatura `X-Hub-Signature-256` é HMAC do corpo com o App Secret. Com um
// segredo por cliente, é preciso saber DE QUEM é a requisição ANTES de validar
// — e o que diz isso está no corpo, que ainda não é confiável. Tentar todos os
// segredos, ou olhar o `phone_number_id` do corpo não validado, seria decidir
// autenticação a partir de entrada do atacante. O CAMINHO
// (`/webhook/<identificador>`) resolve isso antes de qualquer parsing.
//
// O identificador é OPACO (32 hex), não o slug do tenant: a URL vai colada numa
// configuração do app do cliente e aparece em log de proxy — com o slug, ela
// revelaria o nome do cliente e permitiria enumerar a carteira. Ele NÃO
// autentica nada (quem autentica é o HMAC); é um seletor que não vaza
// informação, e por isso pode viver em texto claro no banco.
//
// ── SEGREDOS ────────────────────────────────────────────────────────────────
// O App Secret é cifrado com o MESMO caminho do access token (ia/crypto.js:
// AES-256-GCM, chave derivada de IA_CRYPTO_KEY + tenantId), em CONTEXTO próprio
// — um blob não decifra no contexto do outro. Ele nunca é devolvido por
// nenhuma rota: a tela mostra "configurado" ou "não configurado", nunca o valor.
//
// ── CONEXÃO ────────────────────────────────────────────────────────────────
// `resolverPorIdentificador` roda no caminho do webhook, ANTES de existir
// tenant: usa `db.getConnection()` direto (papel dono, que ignora RLS), do mesmo
// jeito e pelo mesmo motivo que `meta/connection.js::resolver` e
// `webhook/processEvent.js::resolverNumero`. As funções do painel recebem
// `conn` de fora (regra de ouro nº 5: nunca duas conexões do pool na mesma
// requisição).
'use strict';

const crypto = require('crypto');
const db = require('../db/pool');
const { criptografar, descriptografar } = require('../ia/crypto');

const CONTEXTO = 'meta_app_secret';

/** 32 hex — 128 bits de entropia. Formato fechado de propósito: o webhook
    recusa qualquer caminho fora dele SEM ir ao banco (ver webhook/routes.js). */
const FORMATO_IDENTIFICADOR = /^[0-9a-f]{32}$/;

function gerarIdentificador() {
  return crypto.randomBytes(16).toString('hex');
}

function identificadorValido(valor) {
  return typeof valor === 'string' && FORMATO_IDENTIFICADOR.test(valor);
}

/**
 * Resolve o dono de um caminho de webhook e devolve o App Secret EM CLARO para
 * a validação da assinatura. Chamada no caminho quente do webhook.
 *
 * Devolve `null` quando o identificador é inválido/desconhecido OU quando o
 * tenant não tem App Secret gravado — nos dois casos o webhook responde 404 sem
 * distinguir um do outro (não confirmamos a existência de um cliente).
 *
 * ⚠️ RELANÇA erro de banco em vez de devolver null: "não achei" e "não consegui
 * perguntar" têm respostas diferentes (404 vs 503, que faz a Meta reenviar).
 * Colapsar os dois descartaria mensagem de cliente numa queda transitória.
 * @param {string} identificador
 * @returns {Promise<{tenantId: number, appId: string|null, appSecret: string}|null>}
 */
async function resolverPorIdentificador(identificador) {
  if (!identificadorValido(identificador)) return null;
  const conn = await db.getConnection();
  let row;
  try {
    const r = await conn.execute(
      `SELECT tenant_id, app_id, app_secret_criptografado
         FROM meta_conexao
        WHERE webhook_identificador = :ident`,
      { ident: identificador }
    );
    row = (r.rows || [])[0];
  } finally {
    await conn.close().catch(() => {});
  }
  if (!row || !row.APP_SECRET_CRIPTOGRAFADO) return null;
  let appSecret;
  try {
    appSecret = descriptografar(row.APP_SECRET_CRIPTOGRAFADO, row.TENANT_ID, undefined, CONTEXTO);
  } catch (err) {
    // Segredo ilegível (chave trocada, blob corrompido): NÃO é 404. Tratar como
    // "cliente inexistente" faria a Meta desistir; um erro real faz o webhook
    // responder 503 e a mensagem do cliente continua na fila de reentrega dela.
    throw new Error(`App Secret do tenant ${row.TENANT_ID} não pôde ser decifrado: ${err.message}`);
  }
  return { tenantId: Number(row.TENANT_ID), appId: row.APP_ID || null, appSecret };
}

/**
 * Lê o que a TELA precisa — e só isso. Nenhum segredo sai daqui: o App Secret e
 * o access token viram booleanos.
 * @param {object} conn conexão já dentro de comTenant(tenantId)
 */
async function carregar(conn, tenantId) {
  const r = await conn.execute(
    `SELECT app_id, webhook_identificador,
            (app_secret_criptografado IS NOT NULL) AS tem_app_secret,
            (access_token_criptografado IS NOT NULL) AS tem_token,
            status, atualizado_em
       FROM meta_conexao
      WHERE tenant_id = :tenantId`,
    { tenantId }
  );
  const row = (r.rows || [])[0];
  if (!row) {
    return { appId: null, identificador: null, temAppSecret: false, temToken: false, status: null, atualizadoEm: null };
  }
  return {
    appId: row.APP_ID || null,
    identificador: row.WEBHOOK_IDENTIFICADOR || null,
    temAppSecret: row.TEM_APP_SECRET === true,
    temToken: row.TEM_TOKEN === true,
    status: row.STATUS || null,
    atualizadoEm: row.ATUALIZADO_EM || null,
  };
}

/**
 * Grava App ID e/ou App Secret do cliente e garante o identificador do webhook.
 *
 * Campo ausente/vazio = NÃO MEXE (é o que permite trocar só o App ID sem
 * reenviar o segredo, que a tela nunca devolve). O identificador é gerado uma
 * única vez e NUNCA é rotacionado aqui: trocá-lo invalidaria a URL já colada no
 * app do cliente e derrubaria a entrada de mensagens dele em silêncio.
 *
 * Exige a linha de `meta_conexao` já existente — ela nasce com o access token
 * (`meta/connection.js::guardar`), que é NOT NULL. A rota grava o token primeiro.
 * @param {object} conn conexão já dentro de comTenant(tenantId)
 * @returns {Promise<{identificador: string, appId: string|null, appSecretAtualizado: boolean}>}
 */
async function salvar(conn, tenantId, { appId, appSecret } = {}) {
  const id = Number(tenantId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('tenantId inválido');

  const atual = await carregar(conn, id);
  if (!atual.temToken) {
    const err = new Error('Conecte o token permanente do cliente antes de gravar o app da Meta.');
    err.status = 409;
    throw err;
  }

  const appIdLimpo = appId === undefined || appId === null ? null : String(appId).trim();
  const segredoLimpo = appSecret === undefined || appSecret === null ? '' : String(appSecret).trim();
  const identificador = atual.identificador || gerarIdentificador();

  await conn.execute(
    `UPDATE meta_conexao
        SET app_id = COALESCE(:appId, app_id),
            app_secret_criptografado = COALESCE(:segredo, app_secret_criptografado),
            webhook_identificador = COALESCE(webhook_identificador, :ident),
            atualizado_em = now()
      WHERE tenant_id = :tenantId`,
    {
      appId: appIdLimpo || null,
      segredo: segredoLimpo ? criptografar(segredoLimpo, id, undefined, CONTEXTO) : null,
      ident: identificador,
      tenantId: id,
    }
  );

  return {
    identificador,
    appId: appIdLimpo || atual.appId,
    appSecretAtualizado: Boolean(segredoLimpo),
  };
}

/** Caminho público do webhook do cliente. Só monta a string — quem sabe o
    domínio é a rota (ver api/meta.js::baseDoWebhook). */
function caminhoWebhook(identificador) {
  return `/webhook/${identificador}`;
}

module.exports = {
  CONTEXTO,
  FORMATO_IDENTIFICADOR,
  gerarIdentificador,
  identificadorValido,
  resolverPorIdentificador,
  carregar,
  salvar,
  caminhoWebhook,
};
