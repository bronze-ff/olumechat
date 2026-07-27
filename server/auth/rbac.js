// auth/rbac.js — Perfil de autorização (papel + departamentos) por matrícula.
//
// Decisões (ver docs/fase5-plano.md):
//  - Perfil consultado no banco com cache em memória (TTL 30s): papel/departamento
//    mudam sem o usuário precisar relogar, e 1 query a cada 30s é irrelevante.
//  - Bootstrap do primeiro admin: matrículas em DIRETORES_MATRICULAS (.env)
//    entram como ADMIN automaticamente no primeiro acesso.
//  - O atendente é criado lazy aqui (mesma ideia do getOrCreateAtendente do
//    api/conversas.js, que continua existindo para o fluxo de envio).
'use strict';

const db = require('../db/pool');

const TTL_MS = 30_000;
const cache = new Map(); // matricula -> { perfil, exp }

const PAPEIS = ['ADMIN', 'SUPERVISOR', 'ATENDENTE', 'AUDITOR'];

function diretores() {
  return (process.env.DIRETORES_MATRICULAS || '').split(',').filter(Boolean);
}

/**
 * Carrega (criando se preciso) o perfil do usuário.
 * @returns {Promise<{atendenteId, papel, ativo, deptoIds: number[]}>}
 */
async function carregarPerfil(matricula, nome) {
  const key = String(matricula);
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.perfil;

  let conn;
  try {
    conn = await db.getConnection();
    let sel = await conn.execute(
      `SELECT ID, PAPEL, ATIVO, STATUS_PRESENCA, PODE_ATIVO FROM MC_ZAP_ATENDENTE WHERE MATRICULA = :m`,
      { m: matricula }
    );

    let atendenteId, papel, ativo, pausado = false, podeAtivo = false;
    if (sel.rows.length) {
      atendenteId = sel.rows[0].ID;
      papel = sel.rows[0].PAPEL || 'ATENDENTE';
      if (!PAPEIS.includes(papel)) papel = 'ATENDENTE'; // valor fora do enum → fallback seguro
      ativo = sel.rows[0].ATIVO !== 'N';
      pausado = sel.rows[0].STATUS_PRESENCA === 'pausa';
      podeAtivo = sel.rows[0].PODE_ATIVO === 'S';
      // DIRETORES_MATRICULAS só promove a ADMIN na CRIAÇÃO (1º login, no INSERT
      // abaixo). NÃO re-promovemos a cada carregamento: senão um diretor nunca
      // podia ser rebaixado — salvava ATENDENTE e a próxima requisição o jogava
      // de volta pra ADMIN. (Proteção contra trancar o último admin fica no
      // PUT /api/atendentes.)
    } else {
      const { oracledb } = db;
      papel = diretores().includes(key) ? 'ADMIN' : 'ATENDENTE';
      ativo = true;
      const ins = await conn.execute(
        `INSERT INTO MC_ZAP_ATENDENTE (MATRICULA, NOME, PAPEL)
         VALUES (:m, :n, :p) RETURNING ID INTO :id`,
        { m: matricula, n: nome || null, p: papel,
          id: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT } }
      );
      await conn.commit();
      atendenteId = ins.outBinds.id[0];
    }

    const dep = await conn.execute(
      `SELECT DEPARTAMENTO_ID FROM MC_ZAP_ATENDENTE_DEPTO WHERE ATENDENTE_ID = :id`,
      { id: atendenteId }
    );
    const deptoIds = dep.rows.map((r) => r.DEPARTAMENTO_ID);

    // Números (canais) que o atendente atende. LISTA VAZIA = sem restrição = TODOS.
    // Tolerante: se a tabela ainda não existe (script 11 não rodou), trata como
    // sem restrição em vez de derrubar o login (carregarPerfil roda em toda req).
    let numeroIds = [];
    try {
      const num = await conn.execute(
        `SELECT NUMERO_ID FROM MC_ZAP_ATENDENTE_NUMERO WHERE ATENDENTE_ID = :id`,
        { id: atendenteId }
      );
      numeroIds = num.rows.map((r) => r.NUMERO_ID);
    } catch (e) {
      if (e.errorNum !== 942) throw e; // 942 = tabela/view não existe
    }

    // ADMIN sempre pode iniciar conversa ativa.
    const perfil = { atendenteId, papel, ativo, deptoIds, numeroIds, pausado, podeAtivo: podeAtivo || papel === 'ADMIN' };
    cache.set(key, { perfil, exp: Date.now() + TTL_MS });
    return perfil;
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

/** Invalida o cache (chamar quando admin altera papel/departamentos). */
function invalidar(matricula) {
  if (matricula === undefined) cache.clear();
  else cache.delete(String(matricula));
}

/** Middleware: anexa req.perfil (depende do authMiddleware ter setado req.user). */
async function anexarPerfil(req, res, next) {
  try {
    if (!req.user || !req.user.matricula) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    req.perfil = await carregarPerfil(req.user.matricula, req.user.nome);
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

module.exports = { carregarPerfil, invalidar, anexarPerfil, exigirPapel, PAPEIS };
