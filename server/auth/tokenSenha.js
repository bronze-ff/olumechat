// auth/tokenSenha.js — Token de definição de senha no primeiro acesso (FIL-67).
//
// FLUXO: o operador cadastra o usuário (sem senha) e gera um token; o usuário
// recebe o link, escolhe a senha e o token morre. O mesmo mecanismo serve para
// "esqueci minha senha" quando esse ticket existir.
//
// ⚠️ O TOKEN EM CLARO NUNCA VAI PARA O BANCO. Gravamos o SHA-256 dele. Quem
// ler a tabela (dump, backup, injeção) não consegue montar o link. SHA-256 —
// e não argon2 — é o hash certo aqui: o token tem 256 bits de CSPRNG, não há
// dicionário para atacar, e a verificação precisa ser barata. Argon2 é para
// senha humana, que tem entropia baixa. Ver comentário na migração 004.
//
// USO ÚNICO é garantido pelo próprio UPDATE:
//   UPDATE ... SET usado_em = now() WHERE token_hash = :h AND usado_em IS NULL
// Duas requisições simultâneas com o mesmo token: uma pega rowsAffected = 1,
// a outra 0. Não há janela entre "checar" e "marcar".
//
// TUDO roda dentro de comTenant() — o tenant vem de fora (do slug resolvido no
// login/definição), nunca de um campo escolhido pelo cliente.
'use strict';

const crypto = require('crypto');
const db = require('../db/pool');
const senhas = require('./senha');

/** Validade padrão do link de primeiro acesso. */
const TTL_MINUTOS_PADRAO = Number(process.env.SENHA_TOKEN_TTL_MIN) || 60 * 24 * 3; // 3 dias

/** SHA-256 hex do token — o que vai para o banco. */
function hashDoToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Cria um token de definição de senha para `usuarioId` dentro de `tenantId`.
 * Invalida os tokens anteriores em aberto do mesmo usuário — um link novo
 * aposenta o antigo, senão um e-mail vazado meses atrás continuaria válido.
 *
 * O token EM CLARO só existe no retorno desta função: quem chama é responsável
 * por entregá-lo ao usuário (link) e não registrá-lo em log.
 *
 * @param {number} tenantId
 * @param {number} usuarioId
 * @param {{ ttlMinutos?: number }} [opts]
 * @returns {Promise<{ token: string, expiraEm: Date }>}
 */
async function gerarToken(tenantId, usuarioId, opts = {}) {
  const ttl = Number(opts.ttlMinutos) > 0 ? Number(opts.ttlMinutos) : TTL_MINUTOS_PADRAO;
  const token = crypto.randomBytes(32).toString('base64url'); // 256 bits
  const hash = hashDoToken(token);
  const expiraEm = new Date(Date.now() + ttl * 60_000);

  await db.comTenant(tenantId, async (conn) => {
    await conn.execute(
      `UPDATE usuario_token_senha SET usado_em = now()
        WHERE tenant_id = :tenantId AND usuario_id = :uid AND usado_em IS NULL`,
      { tenantId, uid: usuarioId }
    );
    await conn.execute(
      `INSERT INTO usuario_token_senha (tenant_id, usuario_id, token_hash, expira_em)
       VALUES (:tenantId, :uid, :hash, :exp)`,
      { tenantId, uid: usuarioId, hash, exp: expiraEm }
    );
  });

  return { token, expiraEm };
}

/**
 * Diz se o token ainda pode ser usado (não consome). Serve para a tela de
 * definição de senha mostrar "link expirado" ANTES do usuário digitar.
 * @param {number} tenantId
 * @param {string} token  token em claro
 * @returns {Promise<{ valido: boolean, nome?: string|null, email?: string|null }>}
 */
async function verificarToken(tenantId, token) {
  if (typeof token !== 'string' || !token) return { valido: false };
  const hash = hashDoToken(token);
  return db.comTenant(tenantId, async (conn) => {
    const r = await conn.execute(
      `SELECT u.nome, u.email
         FROM usuario_token_senha t
         JOIN usuario u ON u.tenant_id = t.tenant_id AND u.id = t.usuario_id
        WHERE t.tenant_id = :tenantId
          AND t.token_hash = :hash
          AND t.usado_em IS NULL
          AND t.expira_em > now()
          AND u.ativo = 'S'`,
      { tenantId, hash }
    );
    if (!r.rows.length) return { valido: false };
    return { valido: true, nome: r.rows[0].NOME, email: r.rows[0].EMAIL };
  });
}

/**
 * Consome o token e grava a senha nova. Uso único e atômico (ver cabeçalho).
 *
 * Devolve `{ ok: false, motivo }` em vez de lançar: o chamador transforma
 * QUALQUER motivo na mesma resposta ao cliente (não contar se o link expirou,
 * já foi usado ou nunca existiu evita virar oráculo).
 *
 * @param {number} tenantId
 * @param {string} token      token em claro
 * @param {string} senhaNova
 * @returns {Promise<{ ok: true, usuarioId: number } | { ok: false, motivo: string }>}
 */
async function definirSenha(tenantId, token, senhaNova) {
  if (typeof token !== 'string' || !token) return { ok: false, motivo: 'token_ausente' };
  const problema = senhas.validarForca(senhaNova);
  if (problema) return { ok: false, motivo: 'senha_fraca', detalhe: problema };

  // Hash ANTES de abrir a transação: argon2id custa ~50ms de CPU e não há
  // motivo para segurar uma conexão do pool durante isso.
  const hashSenha = await senhas.gerarHash(senhaNova);
  const hashTok = hashDoToken(token);

  return db.comTenant(tenantId, async (conn) => {
    const { tipos } = db;
    const consumo = await conn.execute(
      `UPDATE usuario_token_senha SET usado_em = now()
        WHERE tenant_id = :tenantId
          AND token_hash = :hash
          AND usado_em IS NULL
          AND expira_em > now()
        RETURNING usuario_id INTO :uid`,
      { tenantId, hash: hashTok, uid: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
    );
    if (!consumo.rowsAffected) return { ok: false, motivo: 'token_invalido' };
    const usuarioId = consumo.outBinds.uid[0];

    const upd = await conn.execute(
      `UPDATE usuario
          SET senha_hash = :hash, senha_definida_em = now()
        WHERE tenant_id = :tenantId AND id = :uid AND ativo = 'S'`,
      { tenantId, uid: usuarioId, hash: hashSenha }
    );
    // Usuário desativado entre a emissão do link e o clique. Retornamos (não
    // lançamos), então a transação COMMITA e o token fica queimado — que é o
    // desfecho certo: um link de acesso para conta desativada não deve
    // sobreviver para uma segunda tentativa.
    if (!upd.rowsAffected) return { ok: false, motivo: 'usuario_inativo' };

    return { ok: true, usuarioId };
  });
}

module.exports = { gerarToken, verificarToken, definirSenha, hashDoToken, TTL_MINUTOS_PADRAO };
