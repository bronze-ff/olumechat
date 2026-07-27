// server/ia/tools.js — registro das tools do bot de IA.
//
// O modelo escolhe a tool + parâmetros; NUNCA gera SQL. O SQL de cada tool vive
// num .sql curado, fora do código.
//
// No Falatta o registro é POR TENANT e nasce vazio: cada empresa cadastra as suas
// consultas no painel. Enquanto o CRUD de tools não existe, TOOLS fica vazio e o
// bot de IA responde só com conhecimento textual — sem acesso a dados.
//
// TODO(falatta): trocar o array fixo por leitura do banco, com escopo de tenant.
'use strict';

const TOOLS = [];

function porNome(nome) {
  return TOOLS.find((t) => t.nome === nome) || null;
}

/** Schema neutro (nome/descrição/propriedades) — o client traduz por provedor. */
function schemasParaProvedor() {
  return TOOLS.map((t) => ({
    nome: t.nome,
    descricao: t.descricao,
    propriedades: Object.fromEntries(t.parametros.map((p) => [p.nome, { type: p.tipo, description: p.descricao }])),
    obrigatorios: t.parametros.filter((p) => p.obrigatorio).map((p) => p.nome),
  }));
}

module.exports = { TOOLS, porNome, schemasParaProvedor };
