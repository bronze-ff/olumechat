// server/ia/operacoes.js — executor de operações NOMEADAS do bot de IA.
//
// POR QUE NÃO CABE NO ia/toolExecutor.js: aquele executor sabe UMA coisa —
// ler um .sql curado do disco, validar que é SELECT-only e devolver linhas
// (o modelo nunca vê SQL). "Transferir para um humano" não é consulta: é
// EFEITO, com transação, guarda de corrida e evento de tempo real. Forçar isso
// num .sql exigiria permitir UPDATE ali dentro — e a garantia de SELECT-only é
// justamente o que protege o banco do texto livre do admin.
//
// Então nasce o segundo caminho de execução: um mapa nome → { descricao,
// parametros, executar } no CÓDIGO. O loop de tool-calls do ia/runtime.js
// roteia por tipo: operação nomeada → aqui; o resto → toolExecutor de SQL.
//
// A FIL-85 expande com as demais operações (classificar, rotear, ficha, pedido)
// e com a habilitação por tenant. Aqui o mapa é fixo, com uma entrada só — e é
// de propósito: registro por tenant é problema do próximo ticket.
//
// CONTRATO de `executar(conn, tenantId, ctx, args)`:
//   conn    — conexão JÁ em contexto de tenant (nunca abre a própria)
//   ctx     — { conversaId, contatoId, numeroId }
//   args    — o que o MODELO escreveu: texto livre, sempre suspeito. Toda
//             operação valida e limita o que recebe.
//   retorno — { ok, transferido?, departamento?, mensagemCliente?, eventos? }
//             `eventos` volta para o runtime publicar DEPOIS do commit.
'use strict';

const handoff = require('./handoff');

const MAX_MOTIVO = 500;

const OPERACOES = {
  transferir_para_humano: {
    descricao: 'Transfere o atendimento para uma pessoa da equipe. Use quando o cliente pedir para falar '
      + 'com um atendente, quando você não conseguir resolver com as informações que tem, ou quando o '
      + 'assunto fugir do que foi configurado para você atender. Depois de transferir, você não responde mais.',
    parametros: [
      { nome: 'departamento', tipo: 'string', obrigatorio: false,
        descricao: 'Nome do departamento de destino, se você souber qual é o certo. Se não souber, omita — '
          + 'o sistema escolhe o destino padrão do canal.' },
      { nome: 'motivo', tipo: 'string', obrigatorio: false,
        descricao: 'Em uma frase, por que está transferindo. Aparece para o atendente que receber a conversa.' },
    ],
    async executar(conn, tenantId, ctx, args = {}) {
      // O nome do departamento vem do MODELO — pode não existir. Nome inválido
      // NÃO é erro: vira "sem preferência" e a cascata leva ao padrão do canal.
      // Um erro aqui acabaria virando uma resposta ruim para o cliente final.
      const nome = args.departamento ? String(args.departamento) : '';
      const departamentoId = nome ? await handoff.acharDepartamentoPorNome(conn, tenantId, nome) : null;
      const motivo = args.motivo ? String(args.motivo).slice(0, MAX_MOTIVO) : null;

      const r = await handoff.transferirParaHumano(conn, tenantId, ctx, { departamentoId, motivo });
      if (!r.ok) {
        // O atendente assumiu entre a decisão da IA e este ponto. Nada a fazer,
        // e nada a dizer ao cliente — o humano já está no comando.
        return { ok: false, transferido: false, mensagem: 'A conversa já está com um atendente humano.' };
      }
      return {
        ok: true,
        transferido: true,
        departamento: r.departamentoNome,
        // Texto FIXO, nosso: depois da transferência o `fila_status` já não é
        // 'ia' e a recheca do runtime descartaria qualquer fala do modelo. Sem
        // esta linha o cliente ficaria em silêncio esperando alguém aparecer.
        mensagemCliente: 'Certo! Vou passar você para um atendente da nossa equipe agora. Um instante, por favor.',
        eventos: r.eventos,
      };
    },
  },
};

function porNome(nome) {
  return (nome && Object.prototype.hasOwnProperty.call(OPERACOES, nome)) ? OPERACOES[nome] : null;
}

/** Mesma forma neutra de ia/tools.js — o ia/client.js traduz por provedor. */
function schemasParaProvedor() {
  return Object.entries(OPERACOES).map(([nome, op]) => ({
    nome,
    descricao: op.descricao,
    propriedades: Object.fromEntries(op.parametros.map((p) => [p.nome, { type: p.tipo, description: p.descricao }])),
    obrigatorios: op.parametros.filter((p) => p.obrigatorio).map((p) => p.nome),
  }));
}

module.exports = { OPERACOES, porNome, schemasParaProvedor };
