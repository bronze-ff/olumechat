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
// FIL-85 — a IA que AGE. Entram três operações (ficha, tag, pedido) e, com
// elas, duas coisas novas neste arquivo:
//
//   1. HABILITAÇÃO POR TENANT. O catálogo (schema + execução) continua aqui, no
//      código; o banco (`ia_ferramenta`) só guarda o interruptor. Sem linha no
//      banco vale o `padrao` de cada operação: ficha e tag nascem LIGADAS
//      (escrevem no cadastro que o atendente já edita à mão), pedido nasce
//      DESLIGADO (só faz sentido com template configurado e depois de o admin
//      conhecer a tela de conferência).
//
//   2. SCHEMA DINÂMICO. `aplicar_tag` lista as tags DAQUELA empresa como enum e
//      `registrar_pedido` tem os parâmetros do template DAQUELA empresa. Por
//      isso `schemasParaProvedor` recebe o ESTADO do tenant
//      (ia/ferramentasStore.js). Sem estado (chamador antigo/teste) sobra o que
//      não depende de dado do tenant.
//
// Rotear NÃO virou operação separada de propósito: `transferir_para_humano` já
// recebe o departamento de destino (FIL-84). Uma segunda ferramenta que só
// muda a fila confundiria o modelo sem resolver nada.
//
// CONTRATO de `executar(conn, tenantId, ctx, args)`:
//   conn    — conexão JÁ em contexto de tenant (nunca abre a própria)
//   ctx     — { conversaId, contatoId, numeroId }
//   args    — o que o MODELO escreveu: texto livre, sempre suspeito. Toda
//             operação valida e limita o que recebe.
//   retorno — { ok, erro?, transferido?, departamento?, mensagemCliente?, eventos? }
//             `eventos` volta para o runtime publicar DEPOIS do commit.
'use strict';

const handoff = require('./handoff');
const pedidoTemplate = require('./pedidoTemplate');

const MAX_MOTIVO = 500;

// ---------------------------------------------------------------------------
// Timeline — toda ação da IA vira evento visível para o atendente
//
// `origem='ia'` (não 'sistema'): quem assume a conversa precisa distinguir o
// que a IA fez em nome da empresa do que o sistema fez sozinho. A coluna nasceu
// na migração 021 justamente para isso.
// ---------------------------------------------------------------------------
async function anotarNaTimeline(conn, tenantId, ctx, texto) {
  await conn.execute(
    `INSERT INTO mensagem (tenant_id, conversa_id, contato_id, direcao, tipo, conteudo, origem, ts)
     VALUES (:tenantId, :cv, :ct, 'nota', 'text', :txt, 'ia', now())`,
    { tenantId, cv: ctx.conversaId, ct: ctx.contatoId || null, txt: String(texto).slice(0, 1000) }
  );
}

/** Evento pós-commit padrão de uma ação da IA: a timeline da conversa aberta
 *  precisa recarregar (a nota acabou de entrar nela). */
function eventoConversa(ctx, extra = {}) {
  return { tipo: 'conversa', conversaId: ctx.conversaId, departamentoId: null, ...extra };
}

// ===========================================================================
// atualizar_ficha_contato
// ===========================================================================

/**
 * Campos que a IA pode preencher. É uma LISTA BRANCA e não uma varredura das
 * colunas de `contato` de propósito:
 *   - `codigo_externo` fica de fora: é o vínculo com o sistema do cliente, e um
 *     número chutado pelo modelo ligaria a conversa ao CLIENTE ERRADO.
 *   - `telefone` (principal) fica de fora: é o que identifica o contato nas
 *     conversas; trocar parte o histórico em dois (ver api/contatos.js).
 *   - `observacoes` fica de fora: é a caixa de anotação do ATENDENTE, e a IA
 *     escrevendo lá por cima apagaria contexto humano sem pedir licença.
 * Nada disso exigiu migração — são colunas que já existem (spec §Ferramentas).
 */
const CAMPOS_FICHA = Object.freeze([
  { nome: 'nome_completo', coluna: 'nome_completo', rotulo: 'Nome completo', max: 200,
    descricao: 'Nome completo da pessoa, quando ela se identificar.' },
  { nome: 'razao_social', coluna: 'razao_social', rotulo: 'Razão social', max: 200,
    descricao: 'Razão social da empresa, quando o cliente for pessoa jurídica.' },
  { nome: 'nome_fantasia', coluna: 'nome_fantasia', rotulo: 'Nome fantasia', max: 200,
    descricao: 'Nome fantasia da empresa do cliente.' },
  { nome: 'documento', coluna: 'documento', rotulo: 'CPF/CNPJ', tipo: 'digitos', max: 20,
    descricao: 'CPF ou CNPJ do cliente, só os números.' },
  { nome: 'email', coluna: 'email', rotulo: 'E-mail', tipo: 'email', max: 254,
    descricao: 'E-mail do cliente.' },
  { nome: 'telefone_alternativo', coluna: 'telefone_alternativo', rotulo: 'Telefone alternativo', tipo: 'digitos', max: 20,
    descricao: 'Outro telefone de contato, com DDD, só os números.' },
  { nome: 'cep', coluna: 'cep', rotulo: 'CEP', tipo: 'digitos', max: 9, descricao: 'CEP do endereço, só os números.' },
  { nome: 'logradouro', coluna: 'logradouro', rotulo: 'Logradouro', max: 200, descricao: 'Rua/avenida do endereço.' },
  { nome: 'numero_endereco', coluna: 'numero_endereco', rotulo: 'Número', max: 30, descricao: 'Número do endereço.' },
  { nome: 'complemento', coluna: 'complemento', rotulo: 'Complemento', max: 100, descricao: 'Apartamento, bloco, sala, ponto de referência.' },
  { nome: 'bairro', coluna: 'bairro', rotulo: 'Bairro', max: 100, descricao: 'Bairro do endereço.' },
  { nome: 'cidade', coluna: 'cidade', rotulo: 'Cidade', max: 100, descricao: 'Cidade do endereço.' },
  { nome: 'uf', coluna: 'uf', rotulo: 'UF', tipo: 'uf', max: 2, descricao: 'Sigla do estado, duas letras (ex.: GO).' },
]);

const RE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** @returns {{ valor?: string, erro?: string }} — `undefined` = não mexer. */
function valorDaFicha(campo, bruto) {
  const texto = String(bruto == null ? '' : bruto).trim();
  if (!texto) return { valor: undefined };
  if (campo.tipo === 'digitos') {
    const digitos = texto.replace(/\D/g, '').slice(0, campo.max);
    if (!digitos) return { erro: `"${campo.rotulo}" precisa conter números.` };
    return { valor: digitos };
  }
  if (campo.tipo === 'email') {
    const email = texto.slice(0, campo.max);
    if (!RE_EMAIL.test(email)) return { erro: `"${campo.rotulo}" não parece um e-mail válido.` };
    return { valor: email };
  }
  if (campo.tipo === 'uf') {
    const uf = texto.replace(/[^A-Za-zÀ-ÿ]/g, '').slice(0, 2).toUpperCase();
    if (uf.length !== 2) return { erro: '"UF" é a sigla do estado, com duas letras.' };
    return { valor: uf };
  }
  return { valor: texto.slice(0, campo.max) };
}

async function executarFichaContato(conn, tenantId, ctx, args = {}) {
  if (!ctx.contatoId) return { ok: false, erro: 'Esta conversa não tem contato vinculado.' };

  const colunas = CAMPOS_FICHA.map((c) => c.coluna).join(', ');
  const atual = await conn.execute(
    `SELECT ${colunas} FROM contato WHERE tenant_id = :tenantId AND id = :id`,
    { tenantId, id: ctx.contatoId }
  );
  if (!atual.rows || !atual.rows.length) return { ok: false, erro: 'Contato não encontrado.' };
  const linha = atual.rows[0];

  const sets = [];
  const binds = { tenantId, id: ctx.contatoId };
  const alterados = [];
  const inalterados = [];
  for (const campo of CAMPOS_FICHA) {
    if (!Object.prototype.hasOwnProperty.call(args, campo.nome)) continue;
    const { valor, erro } = valorDaFicha(campo, args[campo.nome]);
    if (erro) return { ok: false, erro };
    if (valor === undefined) continue;
    const anterior = linha[campo.coluna.toUpperCase()] == null ? null : String(linha[campo.coluna.toUpperCase()]);
    if (anterior === valor) { inalterados.push(campo.rotulo); continue; }
    sets.push(`${campo.coluna} = :${campo.nome}`);
    binds[campo.nome] = valor;
    // O valor ANTERIOR volta para o modelo e vai para a nota da timeline: a
    // regra é "nunca sobrescrever valor já preenchido SEM O DIZER" (spec).
    alterados.push({ campo: campo.nome, rotulo: campo.rotulo, de: anterior, para: valor });
  }

  if (!sets.length) {
    return {
      ok: true, alterados: [], inalterados,
      mensagem: inalterados.length
        ? 'A ficha já estava com esses dados — nada foi alterado.'
        : 'Nenhum campo válido para atualizar.',
    };
  }

  await conn.execute(
    `UPDATE contato SET ${sets.join(', ')}, atualizado_em = now()
      WHERE tenant_id = :tenantId AND id = :id`,
    binds
  );

  // Trilha de auditoria sem ator humano: `atendente_id`/`matricula` NULL e o
  // autor no detalhe. Quem editou foi a IA, e inventar um atendente aqui
  // sujaria a trilha de quem realmente mexe na ficha à mão.
  await conn.execute(
    `INSERT INTO auditoria (tenant_id, atendente_id, matricula, acao, entidade, entidade_id, detalhe)
     VALUES (:tenantId, NULL, NULL, 'ia_ficha_contato', 'contato', :id, :det)`,
    { tenantId, id: ctx.contatoId, det: JSON.stringify({ por: 'ia', conversaId: ctx.conversaId, campos: alterados.map((a) => a.campo) }) }
  );

  const detalhe = alterados
    .map((a) => `${a.rotulo}: ${a.para}${a.de ? ` (antes: ${a.de})` : ''}`)
    .join(' · ');
  await anotarNaTimeline(conn, tenantId, ctx, `🤖 A IA atualizou a ficha do contato — ${detalhe}`);

  return {
    ok: true,
    alterados,
    inalterados,
    mensagem: 'Ficha do contato atualizada.',
    eventos: [eventoConversa(ctx), { tipo: 'contato', contatoId: ctx.contatoId }],
  };
}

// ===========================================================================
// aplicar_tag
// ===========================================================================

async function executarAplicarTag(conn, tenantId, ctx, args = {}) {
  const pedida = String(args.tag == null ? '' : args.tag).trim();
  if (!pedida) return { ok: false, erro: 'Diga qual etiqueta aplicar.' };

  // A IA só APLICA tag existente — criar etiqueta é decisão de gestão (spec).
  // Nome inválido é ERRO de ferramenta, nunca criação silenciosa.
  const achou = await conn.execute(
    `SELECT id, nome FROM tag WHERE tenant_id = :tenantId AND lower(nome) = :nome ORDER BY id LIMIT 1`,
    { tenantId, nome: pedida.toLowerCase() }
  );
  if (!achou.rows || !achou.rows.length) {
    const disponiveis = await conn.execute(
      `SELECT nome FROM tag WHERE tenant_id = :tenantId ORDER BY nome LIMIT 40`, { tenantId });
    const nomes = (disponiveis.rows || []).map((r) => r.NOME);
    return {
      ok: false,
      erro: `A etiqueta "${pedida}" não está cadastrada e não pode ser criada por você.`
        + (nomes.length ? ` Etiquetas disponíveis: ${nomes.join(', ')}.` : ''),
    };
  }
  const tag = { id: achou.rows[0].ID, nome: achou.rows[0].NOME };

  const cv = await conn.execute(
    `SELECT tags FROM conversa WHERE tenant_id = :tenantId AND id = :id`,
    { tenantId, id: ctx.conversaId }
  );
  if (!cv.rows || !cv.rows.length) return { ok: false, erro: 'Conversa não encontrada.' };
  const bruto = cv.rows[0].TAGS;
  const atuais = Array.isArray(bruto) ? bruto : (typeof bruto === 'string' ? JSON.parse(bruto || '[]') : []);
  const ids = atuais.map(Number).filter(Number.isInteger);
  if (ids.includes(tag.id)) {
    return { ok: true, tag: tag.nome, jaAplicada: true, mensagem: `A conversa já está etiquetada como "${tag.nome}".` };
  }

  ids.push(tag.id);
  await conn.execute(
    `UPDATE conversa SET tags = :tags WHERE tenant_id = :tenantId AND id = :id`,
    { tenantId, id: ctx.conversaId, tags: JSON.stringify(ids) }
  );
  await anotarNaTimeline(conn, tenantId, ctx, `🤖 A IA aplicou a etiqueta "${tag.nome}".`);

  return {
    ok: true, tag: tag.nome, mensagem: `Etiqueta "${tag.nome}" aplicada à conversa.`,
    eventos: [eventoConversa(ctx)],
  };
}

// ===========================================================================
// registrar_pedido
// ===========================================================================

/** Template do tenant lido NA HORA da escrita (não o do cache que gerou o
 *  schema): entre montar o schema e executar a ferramenta o admin pode ter
 *  salvado outro template, e o que vale para VALIDAR é o que está no banco. */
async function templateAtual(conn, tenantId) {
  const r = await conn.execute(
    `SELECT titulo, campos FROM ia_pedido_template WHERE tenant_id = :tenantId`, { tenantId });
  const linha = (r.rows || [])[0];
  if (!linha) return null;
  return pedidoTemplate.normalizarSalvo({
    titulo: linha.TITULO,
    campos: typeof linha.CAMPOS === 'string' ? JSON.parse(linha.CAMPOS) : linha.CAMPOS,
  });
}

async function executarRegistrarPedido(conn, tenantId, ctx, args = {}) {
  const template = await templateAtual(conn, tenantId);
  if (!template) return { ok: false, erro: 'Esta empresa ainda não configurou o formulário de pedido.' };

  const { payload, resumo, erro } = pedidoTemplate.validarPayload(template, args);
  if (erro) return { ok: false, erro };

  const ins = await conn.execute(
    `INSERT INTO ia_pedido (tenant_id, conversa_id, contato_id, titulo, payload, status)
     VALUES (:tenantId, :cv, :ct, :titulo, :payload::jsonb, 'rascunho') RETURNING id`,
    {
      tenantId, cv: ctx.conversaId, ct: ctx.contatoId || null,
      titulo: template.titulo, payload: JSON.stringify(payload),
    }
  );
  const pedidoId = ins.rows[0].ID;

  await anotarNaTimeline(conn, tenantId, ctx, `🤖 A IA registrou ${template.titulo} (rascunho) — ${resumo}`);

  return {
    ok: true,
    pedidoId,
    registrado: payload.campos,
    mensagem: 'Pedido registrado como rascunho. Um atendente da equipe vai conferir.',
    eventos: [
      eventoConversa(ctx),
      { tipo: 'pedido', conversaId: ctx.conversaId, contatoId: ctx.contatoId || null, pedidoId, status: 'rascunho' },
    ],
  };
}

// ===========================================================================
// Catálogo
// ===========================================================================

const OPERACOES = {
  transferir_para_humano: {
    // `fixa`: não aparece na tela de liga/desliga e nunca é desligada. Sem
    // saída para humano, um cliente que não é entendido pelo modelo fica preso
    // conversando com um robô — é o piso do produto, não um recurso opcional.
    fixa: true,
    padrao: 'S',
    rotulo: 'Transferir para atendente',
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

  atualizar_ficha_contato: {
    padrao: 'S',
    rotulo: 'Preencher a ficha do contato',
    ajuda: 'Deixa o agente completar o cadastro do cliente (nome, documento, e-mail, endereço) com o que ele '
      + 'informar na conversa. O atendente que assumir já encontra a ficha preenchida.',
    descricao: 'Salva no cadastro do cliente os dados que ELE informou nesta conversa (nome, CPF/CNPJ, e-mail, '
      + 'endereço). Use assim que o cliente disser um desses dados — não pergunte por dados que não sejam '
      + 'necessários para o atendimento, e nunca invente nem deduza um valor. Envie somente os campos que '
      + 'você tem certeza; o que você não mandar continua como está.',
    parametros: CAMPOS_FICHA.map((c) => ({ nome: c.nome, tipo: 'string', obrigatorio: false, descricao: c.descricao })),
    executar: executarFichaContato,
  },

  aplicar_tag: {
    padrao: 'S',
    rotulo: 'Aplicar etiqueta na conversa',
    ajuda: 'Deixa o agente classificar a conversa com as etiquetas que a sua empresa já cadastrou. Ele nunca '
      + 'cria etiqueta nova.',
    descricao: 'Marca esta conversa com uma etiqueta já cadastrada pela empresa, para classificar o assunto. '
      + 'Use quando ficar claro do que se trata o atendimento. Só valem as etiquetas da lista — você não pode '
      + 'criar etiqueta nova.',
    // Schema DINÂMICO: as etiquetas são de cada empresa. Sem etiqueta
    // cadastrada a ferramenta não é oferecida (um enum vazio só geraria
    // chamada inválida).
    montarSchema(estado) {
      const tags = (estado && estado.tags) || [];
      if (!tags.length) return null;
      return {
        propriedades: {
          tag: {
            type: 'string',
            description: 'Nome exato da etiqueta a aplicar.',
            enum: tags.map((t) => t.nome),
          },
        },
        obrigatorios: ['tag'],
      };
    },
    executar: executarAplicarTag,
  },

  registrar_pedido: {
    // Nasce DESLIGADA: registrar pedido só faz sentido depois de o admin
    // montar o formulário e conhecer a tela de conferência (spec).
    padrao: 'N',
    rotulo: 'Registrar pedido/agendamento',
    ajuda: 'Deixa o agente preencher o formulário de pedido que você configurar abaixo. O pedido entra como '
      + 'RASCUNHO e um atendente confere antes de valer. Precisa de um formulário configurado.',
    descricao: 'Registra o pedido/agendamento do cliente em um formulário estruturado que a equipe confere '
      + 'depois. Só chame quando tiver todos os dados obrigatórios confirmados pelo cliente — se faltar algum, '
      + 'pergunte antes. Não invente valores.',
    montarSchema(estado) {
      const template = (estado && estado.template) || null;
      // Sem template configurado a ferramenta NÃO é oferecida ao modelo, mesmo
      // com o interruptor ligado (spec) — ela não teria parâmetro nenhum.
      if (!template) return null;
      const { propriedades, obrigatorios } = pedidoTemplate.parametrosDoTemplate(template);
      if (!Object.keys(propriedades).length) return null;
      return { propriedades, obrigatorios, descricaoExtra: ` Formulário desta empresa: ${template.titulo}.` };
    },
    executar: executarRegistrarPedido,
  },
};

/** Operações que o ADMIN liga/desliga na tela (as `fixa` ficam de fora). */
const CONFIGURAVEIS = Object.freeze(
  Object.entries(OPERACOES)
    .filter(([, op]) => !op.fixa)
    .map(([nome, op]) => ({ nome, rotulo: op.rotulo, ajuda: op.ajuda, padrao: op.padrao }))
);

function porNome(nome) {
  return (nome && Object.prototype.hasOwnProperty.call(OPERACOES, nome)) ? OPERACOES[nome] : null;
}

/** Interruptor: linha do banco quando existe, `padrao` do catálogo quando não. */
function ativa(nome, estado) {
  const op = porNome(nome);
  if (!op) return false;
  if (op.fixa) return true;
  const salvo = estado && estado.habilitacao && estado.habilitacao[nome];
  return (salvo || op.padrao) === 'S';
}

function schemaDaOperacao(nome, op, estado) {
  const base = { nome, descricao: op.descricao };
  if (typeof op.montarSchema === 'function') {
    const dinamico = op.montarSchema(estado);
    if (!dinamico) return null; // dado do tenant faltando ⇒ não oferece
    return {
      ...base,
      descricao: op.descricao + (dinamico.descricaoExtra || ''),
      propriedades: dinamico.propriedades,
      obrigatorios: dinamico.obrigatorios,
    };
  }
  return {
    ...base,
    propriedades: Object.fromEntries(op.parametros.map((p) => [p.nome, { type: p.tipo, description: p.descricao }])),
    obrigatorios: op.parametros.filter((p) => p.obrigatorio).map((p) => p.nome),
  };
}

/**
 * Mesma forma neutra de ia/tools.js — o ia/client.js traduz por provedor.
 * @param {{habilitacao: object, tags: array, template: object|null}} [estado]
 *   estado do tenant (ia/ferramentasStore.js). Sem ele sobram só as operações
 *   que não dependem de dado do tenant — é o que chamadores antigos recebem.
 */
function schemasParaProvedor(estado) {
  const out = [];
  for (const [nome, op] of Object.entries(OPERACOES)) {
    if (!ativa(nome, estado)) continue;
    const schema = schemaDaOperacao(nome, op, estado);
    if (schema) out.push(schema);
  }
  return out;
}

/**
 * A operação `nome` pode ser EXECUTADA para este tenant agora?
 *
 * Não basta checar na hora de montar o schema: o histórico da conversa guarda
 * chamadas antigas e o modelo pode repetir o nome de uma ferramenta que o admin
 * acabou de desligar. Quem decide é o servidor, sempre.
 */
function permitida(nome, estado) {
  if (!ativa(nome, estado)) return false;
  const op = porNome(nome);
  return Boolean(schemaDaOperacao(nome, op, estado));
}

module.exports = {
  OPERACOES, CONFIGURAVEIS, CAMPOS_FICHA,
  porNome, ativa, permitida, schemasParaProvedor,
};
