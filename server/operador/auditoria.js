// operador/auditoria.js — Trilha de auditoria do painel do operador (FIL-70).
//
// REGRA DO TICKET: toda ação de operador gera registro — quem, quando, em qual
// tenant, o quê. Não é "best-effort": o INSERT roda DENTRO da mesma transação
// da ação (o `conn` vem de fora, de um comOperador() em andamento). Se a
// auditoria falhar, a ação inteira sofre rollback. Ação sem trilha é pior do
// que ação que não aconteceu — este é o painel que enxerga todos os clientes.
//
// DOIS DESTINOS, PROPÓSITOS DIFERENTES:
//
//   registrar()      → `operador_auditoria`. Trilha INTERNA, cross-tenant, que
//                      só o operador lê. `tenant_id` aqui é o ALVO da ação
//                      (NULO em login/logout/listagem).
//
//   registrarNoTenant() → `auditoria` do tenant, a MESMA tabela que o painel do
//                      cliente já lê. É o que torna o acesso de suporte
//                      "visível para o cliente", como o ticket exige: o
//                      operador entrou na empresa dele e ficou registrado no
//                      lugar onde ele enxerga. Exige contexto de tenant setado
//                      (entrarNoTenant) — e nomeia `tenant_id` mesmo assim.
'use strict';

/** Corta o que não cabe na coluna em vez de estourar o INSERT com 22001. */
function limitar(valor, max) {
  if (valor === null || valor === undefined) return null;
  const s = String(valor);
  return s.length > max ? s.slice(0, max) : s;
}

/** IP da requisição, normalizado para caber em varchar(45). */
function ipDaRequisicao(req) {
  if (!req) return null;
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
  // Atrás de proxy o X-Forwarded-For pode vir com porta ("172.16.0.1:61727").
  const m = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return limitar(m ? m[1] : ip, 45) || null;
}

/**
 * Grava na trilha do operador. Roda no `conn` da transação em andamento.
 * @param {object} conn conexão da transação de operador
 * @param {{ operador?: object, tenantId?: number|null, acao: string,
 *           entidade?: string|null, entidadeId?: number|null,
 *           detalhe?: object|null, ip?: string|null }} dados
 */
async function registrar(conn, dados) {
  const { operador, tenantId, acao, entidade, entidadeId, detalhe, ip } = dados;
  if (!acao) throw new Error('auditoria de operador sem `acao`');
  await conn.execute(
    `INSERT INTO operador_auditoria
       (operador_id, operador_email, tenant_id, acao, entidade, entidade_id, detalhe, ip)
     VALUES (:opId, :opEmail, :tenantId, :acao, :ent, :entId, :det, :ip)`,
    {
      opId: (operador && operador.id) || null,
      opEmail: limitar(operador && operador.email, 160),
      tenantId: tenantId || null,
      acao: limitar(acao, 60),
      ent: limitar(entidade, 40) || null,
      entId: entidadeId || null,
      det: detalhe ? JSON.stringify(detalhe) : null,
      ip: limitar(ip, 45),
    }
  );
}

/**
 * Grava na `auditoria` DO TENANT — a trilha que o cliente enxerga no painel
 * dele. Só use para o que ele TEM que ver (hoje: acesso de suporte).
 * Pressupõe contexto de tenant já setado na transação (entrarNoTenant).
 * @param {object} conn
 * @param {number} tenantId
 * @param {{ acao: string, entidade?: string, entidadeId?: number|null, detalhe?: object|null, ip?: string|null }} dados
 */
async function registrarNoTenant(conn, tenantId, dados) {
  const { acao, entidade, entidadeId, detalhe, ip } = dados;
  if (!acao) throw new Error('auditoria de tenant sem `acao`');
  await conn.execute(
    `INSERT INTO auditoria (tenant_id, acao, entidade, entidade_id, detalhe, ip)
     VALUES (:tenantId, :acao, :ent, :entId, :det, :ip)`,
    {
      tenantId,
      acao: limitar(acao, 60),
      ent: limitar(entidade || 'operador', 40),
      entId: entidadeId || null,
      det: detalhe ? JSON.stringify(detalhe) : null,
      ip: limitar(ip, 45),
    }
  );
}

/**
 * Lista a trilha do operador (mais recentes primeiro). Cross-tenant DE
 * PROPÓSITO: é o log de "quem mexeu em qual cliente". Filtro opcional por
 * tenant.
 * @param {object} conn
 * @param {{ tenantId?: number|null, limite?: number }} [filtros]
 */
async function listar(conn, filtros = {}) {
  const limite = Math.min(Math.max(Number(filtros.limite) || 100, 1), 500);
  const binds = { limite };
  let filtro = '';
  if (filtros.tenantId) {
    filtro = 'WHERE a.tenant_id = :tenantId';
    binds.tenantId = filtros.tenantId;
  }
  const r = await conn.execute(
    `SELECT a.id, a.operador_id, a.operador_email, a.tenant_id, t.slug AS tenant_slug,
            a.acao, a.entidade, a.entidade_id, a.detalhe, a.ip, a.criado_em
       FROM operador_auditoria a
       LEFT JOIN tenant t ON t.id = a.tenant_id
       ${filtro}
      ORDER BY a.criado_em DESC, a.id DESC
      LIMIT :limite`,
    binds
  );
  return r.rows;
}

module.exports = { registrar, registrarNoTenant, listar, ipDaRequisicao };
