// server/ia/pedidoTemplate.js — o template de pedido de UMA empresa: validação
// do que o admin salva, tradução para os parâmetros da ferramenta e validação
// do que o MODELO devolveu (FIL-85).
//
// POR QUE TEMPLATE E NÃO ESTRUTURA FIXA: pizzaria precisa de sabor/tamanho/
// entrega, clínica precisa de data/hora/convênio. Uma estrutura fixa serviria
// mal às duas. Foi escolha explícita do brainstorming (ver a spec).
//
// TUDO AQUI É PURO — sem banco, sem rede. É o que permite testar a regra sem
// subir Postgres, e é a mesma função que roda em dois momentos MUITO
// diferentes:
//   1. o admin salva o template  → normalizarTemplate()
//   2. o modelo chama a ferramenta → validarPayload() contra o template salvo
//
// ⚠️ `args` vem do MODELO: texto livre, sempre suspeito. Campo desconhecido é
// DESCARTADO (o modelo alucina uma chave a mais e isso não pode virar erro de
// atendimento); campo conhecido com valor inválido é ERRO devolvido para ele,
// que tem a chance de corrigir na próxima volta do loop de tool-calls.
'use strict';

const TIPOS = Object.freeze(['texto', 'numero', 'data', 'hora', 'opcoes']);

/** Tetos defensivos. Não são capricho: `campos` vira PARÂMETRO DE FERRAMENTA
 *  enviado ao provedor a cada mensagem — template inchado é custo por turno. */
const LIMITES = Object.freeze({
  titulo: 80,
  campos: 20,
  opcoes: 30,
  nome: 40,
  rotulo: 60,
  opcao: 60,
  descricao: 200,
  valorTexto: 500,
});

/** Marcas de acento na forma decomposta (NFD). Usada para casar "calabresa"
 *  com a opção cadastrada "Calabresa" e para gerar nome de parâmetro ASCII. */
const RE_ACENTO = /[̀-ͯ]/g;

const ROTULO_TIPO = Object.freeze({
  texto: 'texto livre',
  numero: 'número',
  data: 'data (AAAA-MM-DD)',
  hora: 'hora (HH:MM)',
  opcoes: 'uma das opções',
});

// ---------------------------------------------------------------------------
// 1. O que o ADMIN salva
// ---------------------------------------------------------------------------

/** Nome técnico do campo (vira nome de parâmetro no schema do provedor).
 *  Derivado do rótulo quando a tela não manda um: "Sabor da pizza" → sabor_da_pizza. */
function nomeTecnico(bruto) {
  return String(bruto || '')
    .normalize('NFD').replace(RE_ACENTO, '') // sem acento: nome de parâmetro é ASCII
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, LIMITES.nome);
}

/**
 * Valida e normaliza o template vindo da tela do admin.
 * @returns {{ template?: {titulo, campos}, erro?: string }}
 */
function normalizarTemplate(bruto) {
  const b = bruto || {};
  const titulo = String(b.titulo || '').trim();
  if (!titulo) return { erro: 'Dê um título ao pedido (ex.: "Pedido de delivery").' };
  if (titulo.length > LIMITES.titulo) return { erro: `O título excede ${LIMITES.titulo} caracteres.` };

  const brutoCampos = b.campos;
  if (!Array.isArray(brutoCampos)) return { erro: 'Os campos do pedido devem vir em uma lista.' };
  if (!brutoCampos.length) return { erro: 'Configure pelo menos um campo para o pedido.' };
  if (brutoCampos.length > LIMITES.campos) {
    return { erro: `O pedido aceita no máximo ${LIMITES.campos} campos.` };
  }

  const campos = [];
  const vistos = new Set();
  for (const cru of brutoCampos) {
    const c = cru || {};
    const rotulo = String(c.rotulo || '').trim();
    if (!rotulo) return { erro: 'Todo campo precisa de um rótulo (é o que o cliente vê perguntado).' };
    if (rotulo.length > LIMITES.rotulo) return { erro: `O rótulo "${rotulo.slice(0, 20)}…" excede ${LIMITES.rotulo} caracteres.` };

    const nome = nomeTecnico(c.nome || rotulo);
    if (!nome) return { erro: `O campo "${rotulo}" precisa de um nome com letras ou números.` };
    if (vistos.has(nome)) return { erro: `Há dois campos com o mesmo nome interno ("${nome}"). Mude um dos rótulos.` };
    vistos.add(nome);

    const tipo = String(c.tipo || 'texto').trim();
    if (!TIPOS.includes(tipo)) return { erro: `Tipo inválido no campo "${rotulo}". Use: ${TIPOS.join(', ')}.` };

    const campo = { nome, rotulo, tipo, obrigatorio: c.obrigatorio === true || c.obrigatorio === 'S' };

    const descricao = String(c.descricao || '').trim();
    if (descricao) {
      if (descricao.length > LIMITES.descricao) return { erro: `A ajuda do campo "${rotulo}" excede ${LIMITES.descricao} caracteres.` };
      campo.descricao = descricao;
    }

    if (tipo === 'opcoes') {
      const lista = Array.isArray(c.opcoes) ? c.opcoes : [];
      const opcoes = [];
      for (const o of lista) {
        const texto = String(o == null ? '' : o).trim();
        if (!texto) continue;
        if (texto.length > LIMITES.opcao) return { erro: `Uma opção do campo "${rotulo}" excede ${LIMITES.opcao} caracteres.` };
        if (!opcoes.includes(texto)) opcoes.push(texto);
      }
      if (!opcoes.length) return { erro: `O campo "${rotulo}" é de opções — liste ao menos uma.` };
      if (opcoes.length > LIMITES.opcoes) return { erro: `O campo "${rotulo}" excede ${LIMITES.opcoes} opções.` };
      campo.opcoes = opcoes;
    }

    campos.push(campo);
  }

  return { template: { titulo, campos } };
}

/** Template guardado no banco → forma segura de usar (defensivo: o jsonb pode
 *  ter sido escrito por uma versão anterior da tela). `null` quando não há
 *  template utilizável — e SEM template a ferramenta não é oferecida. */
function normalizarSalvo(linha) {
  if (!linha) return null;
  const campos = Array.isArray(linha.campos) ? linha.campos : [];
  const validos = campos
    .filter((c) => c && c.nome && c.rotulo && TIPOS.includes(c.tipo))
    .slice(0, LIMITES.campos);
  if (!validos.length) return null;
  return { titulo: String(linha.titulo || 'Pedido').slice(0, LIMITES.titulo), campos: validos };
}

// ---------------------------------------------------------------------------
// 2. Template → parâmetros da ferramenta (forma neutra do ia/tools.js)
// ---------------------------------------------------------------------------

/** @returns {{ propriedades: object, obrigatorios: string[] }} */
function parametrosDoTemplate(template) {
  const propriedades = {};
  const obrigatorios = [];
  for (const c of (template && template.campos) || []) {
    const prop = {
      type: c.tipo === 'numero' ? 'number' : 'string',
      description: [c.descricao || c.rotulo, `formato: ${ROTULO_TIPO[c.tipo]}`].join(' — '),
    };
    // `opcoes` vira ENUM: o provedor passa a restringir a escolha do modelo em
    // vez de a gente rejeitar depois (menos volta no loop de tool-calls).
    if (c.tipo === 'opcoes') prop.enum = c.opcoes;
    propriedades[c.nome] = prop;
    if (c.obrigatorio) obrigatorios.push(c.nome);
  }
  return { propriedades, obrigatorios };
}

// ---------------------------------------------------------------------------
// 3. O que o MODELO devolveu → payload persistível
// ---------------------------------------------------------------------------

const RE_DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_DATA_BR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const RE_HORA = /^(\d{1,2})[:h](\d{2})/;

function dataValida(ano, mes, dia) {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return false;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

/** @returns {{ valor?: string|number, erro?: string }} */
function normalizarValor(campo, bruto) {
  const texto = String(bruto == null ? '' : bruto).trim();
  if (!texto) return { valor: undefined };

  if (campo.tipo === 'numero') {
    // O modelo escreve "12,50" tanto quanto "12.50" — os dois são o mesmo
    // número em português, e recusar um deles vira volta perdida no loop.
    const n = Number(texto.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) return { erro: `"${campo.rotulo}" precisa ser um número.` };
    return { valor: n };
  }

  if (campo.tipo === 'data') {
    const iso = texto.match(RE_DATA_ISO);
    if (iso) {
      const [, a, m, d] = iso.map(Number);
      if (!dataValida(a, m, d)) return { erro: `"${campo.rotulo}" não é uma data válida.` };
      return { valor: texto };
    }
    const br = texto.match(RE_DATA_BR);
    if (br) {
      const [, d, m, a] = br.map(Number);
      if (!dataValida(a, m, d)) return { erro: `"${campo.rotulo}" não é uma data válida.` };
      return { valor: `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
    }
    return { erro: `"${campo.rotulo}" precisa de uma data no formato AAAA-MM-DD.` };
  }

  if (campo.tipo === 'hora') {
    const h = texto.match(RE_HORA);
    if (!h) return { erro: `"${campo.rotulo}" precisa de uma hora no formato HH:MM.` };
    const hora = Number(h[1]);
    const minuto = Number(h[2]);
    if (hora > 23 || minuto > 59) return { erro: `"${campo.rotulo}" não é uma hora válida.` };
    return { valor: `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}` };
  }

  if (campo.tipo === 'opcoes') {
    // Casa sem diferenciar maiúscula/acento — o modelo escreve "calabresa"
    // onde a opção cadastrada é "Calabresa". Guarda SEMPRE a forma cadastrada.
    const alvo = texto.normalize('NFD').replace(RE_ACENTO, '').toLowerCase();
    const achou = (campo.opcoes || []).find(
      (o) => o.normalize('NFD').replace(RE_ACENTO, '').toLowerCase() === alvo
    );
    if (!achou) {
      return { erro: `"${campo.rotulo}" só aceita: ${(campo.opcoes || []).join(', ')}.` };
    }
    return { valor: achou };
  }

  return { valor: texto.slice(0, LIMITES.valorTexto) };
}

/**
 * Valida `args` do modelo contra o template e monta o payload que vai para o
 * banco. O payload carrega o RÓTULO e o TIPO junto do valor: o template editado
 * depois não pode reescrever o que estava num pedido antigo (é a razão de a
 * cópia existir — ver a spec).
 *
 * @returns {{ payload?: {titulo, campos: object}, resumo?: string, erro?: string }}
 */
function validarPayload(template, args = {}) {
  if (!template || !Array.isArray(template.campos) || !template.campos.length) {
    return { erro: 'Nenhum modelo de pedido configurado para esta empresa.' };
  }
  const campos = {};
  const faltando = [];
  const linhas = [];
  for (const c of template.campos) {
    const { valor, erro } = normalizarValor(c, args[c.nome]);
    if (erro) return { erro };
    if (valor === undefined) {
      if (c.obrigatorio) faltando.push(c.rotulo);
      continue;
    }
    campos[c.nome] = { rotulo: c.rotulo, tipo: c.tipo, valor };
    linhas.push(`${c.rotulo}: ${valor}`);
  }
  if (faltando.length) {
    return { erro: `Faltou preencher: ${faltando.join(', ')}. Pergunte ao cliente antes de registrar.` };
  }
  if (!linhas.length) return { erro: 'Nenhum campo do pedido foi preenchido.' };
  return { payload: { titulo: template.titulo, campos }, resumo: linhas.join(' · ') };
}

module.exports = {
  TIPOS, LIMITES, ROTULO_TIPO,
  nomeTecnico, normalizarTemplate, normalizarSalvo,
  parametrosDoTemplate, validarPayload,
};
