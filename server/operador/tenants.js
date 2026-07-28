// operador/tenants.js — CRUD de tenants e provisionamento (FIL-70).
//
// Tudo aqui roda em comOperador() (contexto de tenant NULO, sem troca de
// papel): é o caminho que atravessa tenants de propósito. Ver operador/db.js.
//
// ── PROVISIONAR É UMA TRANSAÇÃO SÓ ──────────────────────────────────────────
// tenant + usuário administrador + atendente ADMIN vinculado + token do
// convite nascem juntos ou não nascem. Falha em qualquer ponto ⇒ ROLLBACK ⇒
// nenhum tenant órfão (critério de aceite do ticket). Por isso o token de
// senha é inserido AQUI, e não via auth/tokenSenha.js::gerarToken() — aquela
// função abre a própria transação (comTenant), o que quebraria a atomicidade.
// O que se reusa dela é o que não pode divergir: o hash do token e o TTL.
//
// ── O VÍNCULO usuario ↔ atendente ───────────────────────────────────────────
// Convenção vigente (PR #10 / migração 004): `atendente.matricula =
// usuario.id`. O `atendente` normalmente nasce lazy no primeiro login
// (auth/rbac.js), SEMPRE como ATENDENTE — nunca como ADMIN. Se o
// provisionamento não criasse o atendente ADMIN aqui, o primeiro usuário do
// cliente entraria sem poder administrar nada e não haveria quem o
// promovesse. Então o vínculo é fechado explicitamente, na mesma transação.
'use strict';

const crypto = require('crypto');

const { comOperador, entrarNoTenant, sairDoTenant, idValido } = require('./db');
const auditoria = require('./auditoria');
const tokenSenha = require('../auth/tokenSenha');
const { criptografar } = require('../ia/crypto');
const iaConfigStore = require('../ia/iaConfigStore');
const { ErroOperador } = require('./erroOperador');
const { IA_PROVEDORES, validarProviderModeloBaseUrl } = require('./validacaoIa');

const STATUS = Object.freeze(['ativo', 'suspenso', 'encerrado']);

const normalizarEmail = (v) => String(v || '').trim().toLowerCase();

/**
 * Slug = a "empresa" que o usuário digita no login (auth/routes.js). Formato
 * restrito de propósito: ele aparece em link de convite e é comparado byte a
 * byte no login — nada de espaço, acento ou maiúscula.
 */
function normalizarSlug(v) {
  return String(v || '').trim().toLowerCase();
}
function validarSlug(slug) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])$/.test(slug)) {
    throw new ErroOperador(400,
      'Slug inválido: use de 2 a 60 caracteres, apenas letras minúsculas, números e hífen (sem hífen no início ou fim).');
  }
  return slug;
}

/**
 * Listagem com uso por tenant. CROSS-TENANT DE PROPÓSITO: é a tela que mostra
 * TODOS os clientes lado a lado. Os agregados nomeiam `tenant_id` em cada
 * subconsulta — não dependem da RLS para separar os números de um cliente dos
 * de outro (dentro de comOperador não há RLS; ver operador/db.js).
 *
 * "no mês" = mês corrente do servidor (date_trunc('month', now())).
 */
async function listarComUso() {
  return comOperador(async (conn) => {
    const r = await conn.execute(
      `SELECT t.id, t.nome, t.slug, t.status, t.criado_em, t.ia_habilitada,
              t.ia_teto_tokens_mes,
              (SELECT count(*) FROM conversa c
                WHERE c.tenant_id = t.id
                  AND c.criado_em >= date_trunc('month', now()))        AS conversas_mes,
              (SELECT count(*) FROM mensagem m
                WHERE m.tenant_id = t.id AND m.direcao = 'out'
                  AND m.criado_em >= date_trunc('month', now()))        AS mensagens_mes,
              (SELECT count(*) FROM atendente a
                WHERE a.tenant_id = t.id AND a.ativo = 'S')             AS atendentes_ativos,
              (SELECT count(*) FROM numero n
                WHERE n.tenant_id = t.id AND n.ativo = 'S')             AS numeros_conectados,
              (SELECT count(*) FROM usuario u
                WHERE u.tenant_id = t.id AND u.ativo = 'S')             AS usuarios_ativos,
              -- FIL-78: chave própria (ia_config) ainda não migrada pro
              -- operador — o painel usa isto pra saber quem falta migrar.
              (EXISTS (SELECT 1 FROM ia_config ic
                WHERE ic.tenant_id = t.id AND ic.id = 1 AND ic.ativo = 'S')) AS ia_chave_propria,
              -- Consumo do mês corrente (ia_consumo_mensal): FIL-77 é quem
              -- incrementa; aqui só lemos o que já foi registrado.
              COALESCE((SELECT cm.tokens_usados FROM ia_consumo_mensal cm
                         WHERE cm.tenant_id = t.id AND cm.ano_mes = to_char(now(), 'YYYY-MM')), 0) AS ia_tokens_usados_mes,
              (t.ia_teto_tokens_mes IS NOT NULL AND
               COALESCE((SELECT cm.tokens_usados FROM ia_consumo_mensal cm
                          WHERE cm.tenant_id = t.id AND cm.ano_mes = to_char(now(), 'YYYY-MM')), 0) >= t.ia_teto_tokens_mes
              ) AS ia_teto_estourado
         FROM tenant t
        ORDER BY t.nome`
    );
    return r.rows;
  });
}

/** Uma linha de `tenant` pelo id (dentro de uma transação já aberta). */
async function carregarTenant(conn, tenantId) {
  const r = await conn.execute(
    `SELECT id, nome, slug, status FROM tenant WHERE id = :id`, { id: tenantId }
  );
  if (!r.rows.length) throw new ErroOperador(404, 'Tenant não encontrado.');
  return r.rows[0];
}

/**
 * Provisiona um cliente novo: tenant + usuário administrador + atendente ADMIN
 * + convite de definição de senha. Atômico (ver cabeçalho).
 *
 * O token do convite EM CLARO só existe no retorno — quem chama entrega o link
 * e não o registra em log.
 *
 * @param {{ operador: object, nome: string, slug: string,
 *           admin: { nome?: string, email: string }, ip?: string|null,
 *           ttlMinutos?: number }} dados
 * @returns {Promise<{ tenant: object, usuario: object,
 *                     convite: { token: string, expiraEm: Date } }>}
 */
async function provisionar(dados) {
  const nome = String(dados.nome || '').trim();
  const slug = validarSlug(normalizarSlug(dados.slug));
  const emailAdmin = normalizarEmail(dados.admin && dados.admin.email);
  const nomeAdmin = dados.admin && dados.admin.nome ? String(dados.admin.nome).trim().slice(0, 120) : null;

  if (!nome || nome.length > 160) throw new ErroOperador(400, 'Informe o nome da empresa (até 160 caracteres).');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailAdmin) || emailAdmin.length > 160) {
    throw new ErroOperador(400, 'Informe um e-mail válido para o administrador.');
  }

  const ttl = Number(dados.ttlMinutos) > 0 ? Number(dados.ttlMinutos) : tokenSenha.TTL_MINUTOS_PADRAO;
  const token = crypto.randomBytes(32).toString('base64url'); // 256 bits, como em auth/tokenSenha.js
  const hash = tokenSenha.hashDoToken(token);                 // só o SHA-256 vai ao banco
  const expiraEm = new Date(Date.now() + ttl * 60_000);

  const criado = await comOperador(async (conn) => {
    // 1) O tenant. Contexto NULO — é a policy `tenant_operador` (migração 001)
    //    que autoriza escrever aqui, e ela exige tenant_atual() IS NULL.
    let novo;
    try {
      const ins = await conn.execute(
        `INSERT INTO tenant (nome, slug) VALUES (:nome, :slug) RETURNING id, nome, slug, status, criado_em`,
        { nome, slug }
      );
      novo = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') throw new ErroOperador(409, `Já existe um cliente com o slug "${slug}".`);
      throw err;
    }
    const tenantId = Number(novo.ID);

    // 2) Daqui pra frente, contexto do tenant recém-criado: `usuario`,
    //    `atendente` e `usuario_token_senha` têm policy `isolamento_tenant` e
    //    DEFAULT tenant_atual(). Mesmo assim o tenant_id vai explícito em todo
    //    INSERT — dentro de comOperador não existe rede de segurança.
    await entrarNoTenant(conn, tenantId);

    const insUsuario = await conn.execute(
      `INSERT INTO usuario (tenant_id, email, nome) VALUES (:tenantId, :email, :nome)
       RETURNING id, email, nome`,
      { tenantId, email: emailAdmin, nome: nomeAdmin }
    );
    const usuario = insUsuario.rows[0];
    const usuarioId = Number(usuario.ID);

    // 3) Identidade OPERACIONAL do mesmo humano: matricula = usuario.id, papel
    //    ADMIN. Sem isto o primeiro acesso do cliente cairia em ATENDENTE.
    await conn.execute(
      `INSERT INTO atendente (tenant_id, matricula, nome, papel, pode_ativo)
       VALUES (:tenantId, :matricula, :nome, 'ADMIN', 'S')`,
      { tenantId, matricula: usuarioId, nome: nomeAdmin }
    );

    // 4) Convite de definição de senha (uso único, com expiração).
    await conn.execute(
      `INSERT INTO usuario_token_senha (tenant_id, usuario_id, token_hash, expira_em)
       VALUES (:tenantId, :uid, :hash, :exp)`,
      { tenantId, uid: usuarioId, hash, exp: expiraEm }
    );

    // 5) Volta ao contexto de operador para a trilha interna (a tabela
    //    `operador_auditoria` não é de tenant — ver migração 005).
    await sairDoTenant(conn);
    await auditoria.registrar(conn, {
      operador: dados.operador,
      tenantId,
      acao: 'tenant_provisionado',
      entidade: 'tenant',
      entidadeId: tenantId,
      // NUNCA o token em claro aqui: a trilha é lida por gente e vira dump.
      detalhe: { slug, nome, adminEmail: emailAdmin, usuarioId, conviteExpiraEm: expiraEm.toISOString() },
      ip: dados.ip,
    });

    return { tenant: novo, usuario, usuarioId };
  });

  return {
    tenant: criado.tenant,
    usuario: criado.usuario,
    convite: { token, expiraEm },
  };
}

/**
 * Renomeia o cliente. O SLUG é IMUTÁVEL de propósito: ele é a credencial
 * "empresa" do login e vive nos links de convite já entregues — trocá-lo
 * derrubaria o acesso de todo mundo do tenant sem aviso.
 */
async function renomear({ operador, tenantId, nome, ip }) {
  const novoNome = String(nome || '').trim();
  if (!novoNome || novoNome.length > 160) {
    throw new ErroOperador(400, 'Informe o novo nome (até 160 caracteres).');
  }
  return comOperador(async (conn) => {
    const antes = await carregarTenant(conn, tenantId);
    await conn.execute(`UPDATE tenant SET nome = :nome WHERE id = :id`, { nome: novoNome, id: tenantId });
    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'tenant_renomeado', entidade: 'tenant', entidadeId: tenantId,
      detalhe: { de: antes.NOME, para: novoNome, slug: antes.SLUG }, ip,
    });
    return { id: tenantId, nome: novoNome, slug: antes.SLUG, status: antes.STATUS };
  });
}

/**
 * Muda o status do tenant. É o mesmo campo que já governa o resto do sistema:
 *  • `auth/routes.js::resolverTenant` só resolve slug de tenant 'ativo' ⇒
 *    suspender BLOQUEIA O LOGIN de todos os usuários do cliente;
 *  • `campanha/dispatcher.js` (tick e varrerPendentes) só acorda campanha de
 *    tenant 'ativo' ⇒ suspender PAUSA OS DISPAROS.
 * Nenhuma semântica nova foi inventada aqui — é o que o ticket pede, e casa
 * com o filtro que o dispatcher já aplicava.
 *
 * Sessões de tenant JÁ EMITIDAS continuam válidas até expirar: o middleware de
 * tenant não consulta o banco por requisição. Está registrado no PR como
 * resíduo conhecido.
 */
async function alterarStatus({ operador, tenantId, status, motivo, ip }) {
  if (!STATUS.includes(status)) {
    throw new ErroOperador(400, `Status inválido (use: ${STATUS.join(', ')}).`);
  }
  return comOperador(async (conn) => {
    const antes = await carregarTenant(conn, tenantId);
    if (antes.STATUS === status) {
      throw new ErroOperador(409, `O cliente já está com status "${status}".`);
    }
    await conn.execute(`UPDATE tenant SET status = :status WHERE id = :id`, { status, id: tenantId });
    await auditoria.registrar(conn, {
      operador, tenantId,
      acao: status === 'ativo' ? 'tenant_reativado' : `tenant_${status}`,
      entidade: 'tenant', entidadeId: tenantId,
      detalhe: { de: antes.STATUS, para: status, slug: antes.SLUG, motivo: motivo || null },
      ip,
    });
    return { id: tenantId, nome: antes.NOME, slug: antes.SLUG, status };
  });
}

/**
 * Abre uma sessão de SUPORTE num tenant: registra a entrada nas DUAS trilhas
 * (a interna do operador e a `auditoria` do próprio cliente, que ele lê no
 * painel dele — é o "visível para o cliente" do ticket) e devolve os dados do
 * tenant para o router assinar o token de sessão.
 *
 * Funciona mesmo com o tenant suspenso, e isso é deliberado: a sessão de
 * suporte NÃO é um login do cliente (é a credencial do operador trocada por um
 * acesso administrativo escopado, temporário e auditado). Bloqueá-la deixaria
 * o operador sem como implantar ou corrigir justamente o cliente que teve problema.
 */
async function abrirAcessoSuporte({ operador, tenantId, motivo, expiraEm, ip }) {
  return comOperador(async (conn) => {
    const t = await carregarTenant(conn, tenantId);

    // Trilha do cliente: precisa do contexto do tenant (tabela `auditoria` tem
    // policy de isolamento) — e ainda assim nomeia tenant_id.
    await entrarNoTenant(conn, tenantId);
    await auditoria.registrarNoTenant(conn, tenantId, {
      acao: 'acesso_suporte',
      entidade: 'operador',
      entidadeId: (operador && operador.id) || null,
      detalhe: {
        operador: operador && operador.email,
        motivo: motivo || null,
        expiraEm: expiraEm instanceof Date ? expiraEm.toISOString() : expiraEm || null,
      },
      ip,
    });
    await sairDoTenant(conn);

    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'acesso_suporte', entidade: 'tenant', entidadeId: tenantId,
      detalhe: {
        slug: t.SLUG, statusDoTenant: t.STATUS, motivo: motivo || null,
        expiraEm: expiraEm instanceof Date ? expiraEm.toISOString() : expiraEm || null,
      },
      ip,
    });

    return { id: Number(t.ID), nome: t.NOME, slug: t.SLUG, status: t.STATUS };
  });
}

/** Trilha de auditoria do operador (cross-tenant; filtro opcional por tenant). */
async function listarAuditoria(filtros = {}) {
  return comOperador(async (conn) => auditoria.listar(conn, filtros));
}

/**
 * Liga/desliga o add-on de IA no PLANO do tenant. É o único jeito de habilitar
 * — o admin do cliente não tem esse botão (ver api/iaConfig.js, só leitura).
 * Desligar NÃO apaga o provedor configurado (ia_config): só o bot/recursos
 * param de rodar (runtime.js e a rota de sugestão de resposta checam o flag).
 */
async function definirIa({ operador, tenantId, habilitada, ip }) {
  return comOperador(async (conn) => {
    const antes = await carregarTenant(conn, tenantId);
    const valor = habilitada ? 'S' : 'N';
    await conn.execute(`UPDATE tenant SET ia_habilitada = :v WHERE id = :id`, { v: valor, id: tenantId });
    await auditoria.registrar(conn, {
      operador, tenantId, acao: habilitada ? 'ia_habilitada' : 'ia_desabilitada',
      entidade: 'tenant', entidadeId: tenantId, detalhe: { slug: antes.SLUG }, ip,
    });
    return { id: tenantId, nome: antes.NOME, slug: antes.SLUG, iaHabilitada: habilitada };
  });
}

/** Status do provedor de IA de um tenant (sem a chave) — pro operador ver o
    que já está configurado antes de trocar. */
async function carregarIaConfig(tenantId) {
  return comOperador(async (conn) => {
    await carregarTenant(conn, tenantId); // 404 se o tenant não existe
    const r = await conn.execute(
      `SELECT provider, modelo, base_url, ativo, atualizado_em FROM ia_config WHERE tenant_id = :id AND id = 1`,
      { id: tenantId });
    if (!r.rows.length) return { provider: null, modelo: null, baseUrl: null, ativo: false, atualizadoEm: null };
    const row = r.rows[0];
    return { provider: row.PROVIDER, modelo: row.MODELO, baseUrl: row.BASE_URL, ativo: row.ATIVO === 'S', atualizadoEm: row.ATUALIZADO_EM };
  });
}

/**
 * Grava/atualiza provider+modelo+chave de UM tenant (chave própria — legado
 * pré-FIL-78). SÓ o operador chama isto (rota
 * /api/operador/tenants/:id/ia-config) — `entrarNoTenant` troca o contexto pro
 * DEFAULT tenant_atual() de ia_config apontar certo; comOperador já roda com
 * BYPASSRLS (ver operador/db.js), então a escrita em si não depende de policy.
 *
 * FIL-78: a credencial GLOBAL do operador (operador/credencialIa.js) é o
 * caminho novo — esta função continua existindo só para os tenants que JÁ
 * têm chave própria continuarem funcionando e o operador poder ajustá-la; não
 * é mais o fluxo recomendado para clientes novos.
 */
async function salvarIaConfig({ operador, tenantId, provider, modelo, baseUrl, apiKey, ip }) {
  const v = validarProviderModeloBaseUrl({ provider, modelo, baseUrl });
  const modeloTrim = v.modelo;
  const baseNorm = v.baseUrl;
  const temChaveNova = apiKey && String(apiKey).trim();

  return comOperador(async (conn) => {
    const antes = await carregarTenant(conn, tenantId);
    await entrarNoTenant(conn, tenantId);

    let cifrada;
    if (temChaveNova) {
      cifrada = criptografar(String(apiKey), tenantId);
    } else {
      const ex = await conn.execute(`SELECT api_key_criptografada FROM ia_config WHERE tenant_id = :id AND id = 1`, { id: tenantId });
      cifrada = ex.rows.length ? ex.rows[0].API_KEY_CRIPTOGRAFADA : null;
      if (!cifrada) throw new ErroOperador(400, 'API key obrigatória na primeira configuração deste cliente.');
    }
    await conn.execute(
      `INSERT INTO ia_config (tenant_id, id, provider, modelo, base_url, api_key_criptografada, ativo, atualizado_em)
       VALUES (:tenantId, 1, :p, :m, :b, :k, 'S', now())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         provider = EXCLUDED.provider, modelo = EXCLUDED.modelo, base_url = EXCLUDED.base_url,
         api_key_criptografada = EXCLUDED.api_key_criptografada, ativo = 'S',
         atualizado_por = NULL, atualizado_em = now()`,
      { tenantId, p: provider, m: modeloTrim, b: baseNorm, k: cifrada });
    await sairDoTenant(conn);

    await auditoria.registrar(conn, {
      operador, tenantId, acao: 'ia_config_alterada_pelo_operador', entidade: 'ia_config', entidadeId: 1,
      detalhe: { slug: antes.SLUG, provider, modelo: modeloTrim, baseUrl: baseNorm, chaveTrocada: !!temChaveNova }, ip,
    });
    iaConfigStore.invalidar(tenantId);
    return { provider, modelo: modeloTrim, baseUrl: baseNorm, ativo: true };
  });
}

module.exports = {
  listarComUso, provisionar, renomear, alterarStatus, abrirAcessoSuporte,
  listarAuditoria, definirIa, carregarIaConfig, salvarIaConfig,
  validarSlug, normalizarSlug, ErroOperador, STATUS, idValido,
  IA_PROVEDORES, validarProviderModeloBaseUrl,
};
