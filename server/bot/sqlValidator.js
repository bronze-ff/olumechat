// bot/sqlValidator.js — validação SELECT-only reutilizável (motor de fluxo + tools de IA).
'use strict';

// ── Regras de abuso do banco COMPARTILHADO (dialeto Postgres) ───────────────
// Valem para QUALQUER SELECT livre que um usuário do painel escreva — o nó
// 'consulta' do bot, as tools de IA e o segmento de campanha. Ficam aqui, em
// um lugar só, porque duas cópias divergem: quem endurecer uma esquece a outra.

/** Tabelas que nenhum SELECT do produto tem motivo de ler.
 *  • `ia_config` guarda a chave de IA cifrada;
 *  • `usuario` / `usuario_token_senha` guardam `senha_hash` e os tokens de
 *    primeiro acesso (FIL-67). A RLS impede ler o tenant do vizinho, mas nada
 *    impediria um SELECT curado despejar as credenciais dos colegas DO PRÓPRIO
 *    tenant.
 *  `\b` não pega coluna: `usuario_id` não casa (o `_` é caractere de palavra). */
const RE_TABELAS_PROTEGIDAS = /\b(ia_config|usuario(_token_senha)?)\b/i;

const RE_FUNCOES_PERIGOSAS =
  /\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink|lo_import|lo_export|pg_terminate_backend|pg_cancel_backend)\b\s*\(/i;

const RE_CATALOGO = /\b(pg_catalog|information_schema)\b/i;

/**
 * Checagens de abuso do banco compartilhado. Recebe o SQL JÁ SEM COMENTÁRIOS
 * (senão dá para esconder `pg_sleep` atrás de um `--`). Devolve array de erros.
 * @param {string} sql
 * @returns {string[]}
 */
function validarAbusoPostgres(sql) {
  const erros = [];
  if (RE_TABELAS_PROTEGIDAS.test(sql)) erros.push('Tabela protegida não permitida.');
  if (RE_FUNCOES_PERIGOSAS.test(sql)) erros.push('Função não autorizada.');
  // set_config() muda app.current_tenant_id NA MESMA transação — um SUPERVISOR
  // poderia ler dado de outro tenant contornando a RLS sem nunca sair do
  // comTenant() corrente. SET/RESET (role, GUC de sessão) é a mesma classe de
  // ataque por outro caminho. Nenhum SELECT legítimo precisa desses comandos —
  // bloqueio total, não só dentro de chamada de função.
  if (/\bset_config\b/i.test(sql) || /(?:^|[^a-z0-9_])(set|reset)\b/i.test(sql)) {
    erros.push('Comando de sessão/contexto não autorizado.');
  }
  if (RE_CATALOGO.test(sql)) erros.push('Catálogo do sistema não permitido.');
  return erros;
}

/** Devolve array de erros ([] = ok). Mesmas regras do nó 'consulta'.
 *  IMPORTANTE: remove comentários (-- linha, /* bloco *​/) ANTES das checagens —
 *  os .sql curados começam com um cabeçalho comentado, senão o ^SELECT reprovaria
 *  toda query. As checagens de segurança também rodam sobre o texto sem comentário
 *  (não dá pra burlar escondendo pg_sleep/dblink/ia_config num comentário).
 *
 *  Dialeto Postgres: RLS já confina qualquer SELECT ao tenant corrente (roda
 *  dentro de comTenant()), então isto não é a defesa contra vazamento entre
 *  tenants — é a defesa contra abuso do banco COMPARTILHADO em si (funções que
 *  tocam o sistema de arquivos/rede, ou tabelas internas que não são "dado de
 *  negócio" do tenant, como ia_config com a chave de IA cifrada ou `usuario`
 *  com o hash da senha). */
function validarSQL(sqlRaw) {
  const sql = String(sqlRaw || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  const erros = [];
  if (!/^select\s/i.test(sql)) erros.push('O SQL deve começar com SELECT.');
  // Sobre o texto SEM comentário: rejeita qualquer ";" (bloqueia múltiplos
  // statements). Um ";" que só existisse dentro de um comentário não conta.
  if (sql.includes(';')) erros.push('O SQL não pode conter ";".');
  erros.push(...validarAbusoPostgres(sql));
  return erros;
}

module.exports = { validarSQL, validarAbusoPostgres };
