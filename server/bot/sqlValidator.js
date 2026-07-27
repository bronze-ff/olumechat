// bot/sqlValidator.js — validação SELECT-only reutilizável (motor de fluxo + tools de IA).
'use strict';

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
 *  negócio" do tenant, como ia_config com a chave de IA cifrada). */
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
  if (/\bia_config\b/i.test(sql)) erros.push('Tabela protegida não permitida.');
  if (/\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink|lo_import|lo_export|pg_terminate_backend|pg_cancel_backend)\b\s*\(/i.test(sql)) {
    erros.push('Função não autorizada.');
  }
  // set_config() muda app.current_tenant_id NA MESMA transação — um SUPERVISOR
  // poderia ler dado de outro tenant contornando a RLS sem nunca sair do
  // comTenant() corrente. SET/RESET (role, GUC de sessão) é a mesma classe de
  // ataque por outro caminho. Nenhum SELECT legítimo do nó 'consulta' precisa
  // desses comandos — bloqueio total, não só dentro de chamada de função.
  if (/\bset_config\b/i.test(sql) || /(?:^|[^a-z0-9_])(set|reset)\b/i.test(sql)) {
    erros.push('Comando de sessão/contexto não autorizado.');
  }
  if (/\b(pg_catalog|information_schema)\b/i.test(sql)) erros.push('Catálogo do sistema não permitido.');
  return erros;
}

module.exports = { validarSQL };
