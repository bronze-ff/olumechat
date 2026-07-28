// server/ia/tools.js — registro das tools do bot de IA.
//
// O modelo escolhe a tool + parâmetros; NUNCA gera SQL. O SQL de cada tool vive
// num .sql curado, fora do código.
//
// No Falatta o registro é POR TENANT e nasce vazio: cada empresa cadastra as suas
// consultas no painel. Enquanto o CRUD de tools não existe, TOOLS fica vazio e o
// bot de IA responde só com conhecimento textual — sem acesso a dados.
//
// FIL-84: o que o provedor recebe deixou de ser só isto. Existem DOIS registros
// — as tools de SQL (aqui) e as operações NOMEADAS (ia/operacoes.js: efeito no
// código, sem SQL em disco). O modelo não precisa saber a diferença: recebe a
// união dos schemas; quem roteia na EXECUÇÃO é o loop do ia/runtime.js.
//
// TODO(falatta): trocar o array fixo por leitura do banco, com escopo de tenant.
'use strict';

const operacoes = require('./operacoes');

const TOOLS = [];

function porNome(nome) {
  return TOOLS.find((t) => t.nome === nome) || null;
}

/** Schema neutro (nome/descrição/propriedades) — o client traduz por provedor.
 *  União: tools de SQL + operações nomeadas. */
function schemasParaProvedor() {
  const deSql = TOOLS.map((t) => ({
    nome: t.nome,
    descricao: t.descricao,
    propriedades: Object.fromEntries(t.parametros.map((p) => [p.nome, { type: p.tipo, description: p.descricao }])),
    obrigatorios: t.parametros.filter((p) => p.obrigatorio).map((p) => p.nome),
  }));
  return [...deSql, ...operacoes.schemasParaProvedor()];
}

module.exports = { TOOLS, porNome, schemasParaProvedor };
