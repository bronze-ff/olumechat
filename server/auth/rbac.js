// auth/rbac.js — Perfil de autorização (papel + departamentos) por matrícula,
// ESCOPADO POR TENANT (FIL-59, porte da fundação FIL-58): o papel de uma
// matrícula só vale dentro do tenant em que ela foi carregada.
//
// Decisões (ver docs/fase5-plano.md):
//  - Perfil consultado no banco com cache em memória (TTL 30s): papel/departamento
//    mudam sem o usuário precisar relogar, e 1 query a cada 30s é irrelevante.
//  - TODO usuário nasce ATENDENTE. Não existe promoção automática a ADMIN por
//    variável de ambiente: a lista de matrículas privilegiadas que o fork
//    trazia era bootstrap do cliente antigo e, num SaaS multi-tenant,
//    promoveria a MESMA matrícula em TODOS os tenants (removida no FIL-67). O
//    primeiro ADMIN de um tenant nasce no provisionamento, pelo painel do
//    operador (FIL-70).
//  - O atendente é criado lazy aqui (mesma ideia do getOrCreateAtendente do
//    api/conversas.js, que continua existindo para o fluxo de envio).
'use strict';

const db = require('../db/pool');

const TTL_MS = 30_000;
const cache = new Map(); // `${tenantId}:${matricula}` -> { perfil, exp }

const PAPEIS = ['ADMIN', 'SUPERVISOR', 'ATENDENTE', 'AUDITOR'];

/**
 * Carrega (criando se preciso) o perfil do usuário DENTRO do tenant informado.
 * Roda sob comTenant() — RLS garante o isolamento; o filtro tenant_id explícito
 * nas queries é defesa em profundidade (auditável, independe da RLS).
 * @returns {Promise<{atendenteId, papel, ativo, deptoIds: number[]}>}
 */
async function carregarPerfil(tenantId, matricula, nome) {
  const key = `${tenantId}:${matricula}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.perfil;

  const perfil = await db.comTenant(tenantId, async (conn) => {
    let sel = await conn.execute(
      `SELECT id, papel, ativo, status_presenca, pode_ativo
         FROM atendente WHERE tenant_id = :tenantId AND matricula = :m`,
      { tenantId, m: matricula }
    );

    let atendenteId, papel, ativo, pausado = false, podeAtivo = false;
    if (sel.rows.length) {
      atendenteId = sel.rows[0].ID;
      papel = sel.rows[0].PAPEL || 'ATENDENTE';
      if (!PAPEIS.includes(papel)) papel = 'ATENDENTE'; // valor fora do enum → fallback seguro
      ativo = sel.rows[0].ATIVO !== 'N';
      pausado = sel.rows[0].STATUS_PRESENCA === 'pausa';
      podeAtivo = sel.rows[0].PODE_ATIVO === 'S';
      // O papel vem SEMPRE do banco, nunca de configuração de ambiente — quem
      // promove é o ADMIN do tenant pelo PUT /api/atendentes (que também
      // protege contra trancar o último admin).
    } else {
      const { tipos } = db;
      papel = 'ATENDENTE'; // sempre; promoção é ato de ADMIN, no banco
      ativo = true;
      const ins = await conn.execute(
        `INSERT INTO atendente (tenant_id, matricula, nome, papel)
         VALUES (:tenantId, :m, :n, :p) RETURNING id INTO :id`,
        { tenantId, m: matricula, n: nome || null, p: papel,
          id: { type: tipos.NUMBER, dir: tipos.BIND_OUT } }
      );
      atendenteId = ins.outBinds.id[0];
    }

    const dep = await conn.execute(
      `SELECT departamento_id FROM atendente_depto WHERE tenant_id = :tenantId AND atendente_id = :id`,
      { tenantId, id: atendenteId }
    );
    const deptoIds = dep.rows.map((r) => r.DEPARTAMENTO_ID);

    // Números (canais) que o atendente atende. LISTA VAZIA = sem restrição = TODOS.
    const num = await conn.execute(
      `SELECT numero_id FROM atendente_numero WHERE tenant_id = :tenantId AND atendente_id = :id`,
      { tenantId, id: atendenteId }
    );
    const numeroIds = num.rows.map((r) => r.NUMERO_ID);

    // ADMIN sempre pode iniciar conversa ativa.
    return { atendenteId, papel, ativo, deptoIds, numeroIds, pausado, podeAtivo: podeAtivo || papel === 'ADMIN' };
  });

  cache.set(key, { perfil, exp: Date.now() + TTL_MS });
  return perfil;
}

/**
 * Invalida o cache (chamar quando admin altera papel/departamentos).
 * Sem argumento: limpa tudo. Só `matricula`: limpa essa matrícula em
 * QUALQUER tenant (chamadores hoje não conhecem o tenant_id — ver call
 * sites em api/atendentes.js e api/presenca.js).
 */
function invalidar(matricula) {
  if (matricula === undefined) { cache.clear(); return; }
  const alvo = `:${matricula}`;
  for (const key of cache.keys()) {
    if (key.endsWith(alvo)) cache.delete(key);
  }
}

/**
 * Perfil de uma SESSÃO DE IMPLANTAÇÃO do operador (FIL-70). Não vem do banco e
 * não cria `atendente`: o operador não é funcionário do cliente e não pode
 * aparecer como autor de mensagem nem entrar na fila.
 *
 * ADMIN libera implantação e configuração completa dentro do tenant escolhido.
 * `atendenteId: null` mantém o operador fora da presença e da distribuição;
 * as ações administrativas ficam atribuídas ao operador pela auditoria central
 * de auth/middleware.js, e não a um funcionário fictício do cliente.
 */
const PERFIL_SUPORTE = Object.freeze({
  atendenteId: null, papel: 'ADMIN', ativo: true,
  deptoIds: [], numeroIds: [], pausado: false, podeAtivo: true, suporte: true,
});

/** Middleware: anexa req.perfil. Depende do authMiddleware ter setado req.user
 *  com tenantId e matricula — ambos vêm do JWT emitido pelo login próprio
 *  (FIL-67), e o middleware já rejeita token sem tenantId. A checagem aqui é
 *  defesa em profundidade para quem montar a cadeia de middlewares errada. */
async function anexarPerfil(req, res, next) {
  try {
    // Sessão de suporte: tenant explicitamente selecionado no painel do
    // operador, sem matrícula (não há usuário do cliente por trás dela).
    if (req.user && req.user.tenantId && req.user.suporte === true) {
      req.perfil = PERFIL_SUPORTE;
      return next();
    }
    if (!req.user || !req.user.matricula || !req.user.tenantId) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    req.perfil = await carregarPerfil(req.user.tenantId, req.user.matricula, req.user.nome);
    if (!req.perfil.ativo) {
      return res.status(403).json({ error: 'Usuário desativado no sistema' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Middleware-fábrica: exige um dos papéis (usar APÓS anexarPerfil). */
function exigirPapel(...papeis) {
  return (req, res, next) => {
    if (!req.perfil) return res.status(401).json({ error: 'Perfil não carregado' });
    if (!papeis.includes(req.perfil.papel)) {
      return res.status(403).json({ error: 'Sem permissão para esta ação' });
    }
    next();
  };
}

module.exports = { carregarPerfil, invalidar, anexarPerfil, exigirPapel, PAPEIS, PERFIL_SUPORTE };
