// Mesma allowlist de server/observabilidade/scrub.js. O teste de paridade
// compara a saída dos dois. Não caminhe campos de transporte do SDK.

export const REDACAO = '[Redacted]';

const PALAVRAS = [
  'senha', 'password', 'passwd', 'token', 'authorization', 'cookie',
  'secret', 'bearer', 'cpf', 'cnpj',
];

const MARCA_CHAT = /wamid|wa_id|phone_number_id|messaging_product|"text"\s*:|"body"\s*:|mensagem do cliente|texto do cliente/i;

const CPF = /(?:^|[^\d])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/;
const CNPJ = /(?:^|[^\d])\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const TELEFONE = /(?:^|\D)(?:\+?55\s?)?(?:\(\d{2}\)|\d{2})\s?9?\d{4}[-\s]?\d{4}(?!\d)/;
const PLACA = /\b[A-Z]{3}-?\d{4}\b|\b[A-Z]{3}\d[A-Z]\d{2}\b/;

const CAMPOS_TRANSPORTE = [
  'event_id', 'timestamp', 'platform', 'level', 'logger', 'environment',
  'release', 'dist', 'sdk', 'fingerprint', 'transaction_info',
];

const CHAVES_ATRIBUTO_DESCARTAR = /header|cookie|query|body|authorization|token|senha|secret|password|payload|mensagem|texto|text|content/i;
const CHAVES_URL = /^(url|http\.url|url\.full|http\.target|http\.path|request\.url)$/i;

function temPalavraSensivel(texto) {
  const normalizado = String(texto).toLowerCase();
  for (const palavra of PALAVRAS) {
    let i = 0;
    while ((i = normalizado.indexOf(palavra, i)) !== -1) {
      const antes = i === 0 ? '' : normalizado[i - 1];
      const depois = normalizado[i + palavra.length] || '';
      const bordaAntes = antes === '' || !/[a-z]/.test(antes);
      const bordaDepois = depois === '' || !/[a-z]/.test(depois);
      if (bordaAntes && bordaDepois) return true;
      i += palavra.length;
    }
  }
  return false;
}

export function stringDeveSerRedigida(texto) {
  if (typeof texto !== 'string' || texto.length === 0) return false;
  if (temPalavraSensivel(texto)) return true;
  if (MARCA_CHAT.test(texto)) return true;
  if (CPF.test(texto) || CNPJ.test(texto) || EMAIL.test(texto)) return true;
  if (TELEFONE.test(texto) || PLACA.test(texto)) return true;
  if (texto.length > 500) return true;
  return false;
}

export function redigirString(texto) {
  if (typeof texto !== 'string') return texto;
  return stringDeveSerRedigida(texto) ? REDACAO : texto;
}

export function urlOrigemCaminho(valor) {
  if (typeof valor !== 'string' || valor.length === 0) return valor;
  const semFragmento = valor.split('#')[0];
  try {
    // Só http(s) tem origem opaca útil. file:// e webpack:// devolvem
    // origin "null" e estragariam o caminho do frame.
    if (/^https?:\/\//i.test(semFragmento)) {
      const u = new URL(semFragmento);
      return `${u.origin}${u.pathname}`;
    }
  } catch {
    // valor que parece URL mas não parseia cai no corte abaixo
  }
  return semFragmento.split('?')[0];
}

function limparTextoLivre(texto) {
  if (typeof texto !== 'string') return texto;
  const semSegredoNaUrl = /https?:\/\//i.test(texto) ? urlOrigemCaminho(texto) : texto;
  return redigirString(semSegredoNaUrl);
}

function idSeguro(id) {
  if (id == null || id === '') return null;
  const s = String(id);
  if (s.length > 64 || stringDeveSerRedigida(s)) return null;
  return s;
}

function copiarTransporte(origem, destino) {
  for (const chave of CAMPOS_TRANSPORTE) {
    if (origem[chave] !== undefined) destino[chave] = origem[chave];
  }
}

function permitirRequest(req) {
  if (!req || typeof req !== 'object') return undefined;
  const out = {};
  if (typeof req.method === 'string') out.method = req.method.slice(0, 16);
  if (typeof req.url === 'string') out.url = redigirString(urlOrigemCaminho(req.url));
  return out;
}

export function chaveDescartada(chave) {
  const texto = String(chave);
  return temPalavraSensivel(texto) || CHAVES_ATRIBUTO_DESCARTAR.test(texto);
}

function permitirMapa(mapa) {
  const out = {};
  if (!mapa || typeof mapa !== 'object') return out;
  for (const [chave, valor] of Object.entries(mapa)) {
    if (chaveDescartada(chave)) continue;
    if (typeof valor === 'string') out[chave] = redigirString(valor);
    else if (typeof valor === 'number' || typeof valor === 'boolean') out[chave] = valor;
  }
  return out;
}

function permitirContextos(contexts) {
  const out = {};
  if (!contexts || typeof contexts !== 'object') return out;
  for (const nome of ['os', 'runtime', 'device', 'browser', 'app']) {
    if (contexts[nome] && typeof contexts[nome] === 'object') {
      out[nome] = permitirMapa(contexts[nome]);
    }
  }
  if (contexts.trace && typeof contexts.trace === 'object') {
    const trace = {};
    for (const chave of ['trace_id', 'span_id', 'parent_span_id', 'op', 'status']) {
      const valor = contexts.trace[chave];
      if (valor != null && typeof valor !== 'object') trace[chave] = valor;
    }
    out.trace = trace;
  }
  return out;
}

function permitirFrame(frame) {
  if (!frame || typeof frame !== 'object') return frame;
  const out = {};
  if (typeof frame.filename === 'string') out.filename = redigirString(urlOrigemCaminho(frame.filename));
  if (typeof frame.abs_path === 'string') out.abs_path = redigirString(urlOrigemCaminho(frame.abs_path));
  if (typeof frame.function === 'string') out.function = redigirString(frame.function);
  if (typeof frame.module === 'string') out.module = redigirString(frame.module);
  if (frame.lineno != null) out.lineno = frame.lineno;
  if (frame.colno != null) out.colno = frame.colno;
  if (frame.in_app != null) out.in_app = frame.in_app;
  return out;
}

function permitirExcecao(bloco) {
  if (!bloco || typeof bloco !== 'object') return bloco;
  const valores = Array.isArray(bloco.values) ? bloco.values : [];
  return {
    values: valores.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const out = {};
      if (typeof item.type === 'string') out.type = item.type;
      if (typeof item.value === 'string') out.value = redigirString(item.value);
      if (item.mechanism && typeof item.mechanism === 'object') {
        out.mechanism = {};
        if (typeof item.mechanism.type === 'string') out.mechanism.type = item.mechanism.type;
        if (typeof item.mechanism.handled === 'boolean') out.mechanism.handled = item.mechanism.handled;
      }
      const frames = item.stacktrace && Array.isArray(item.stacktrace.frames)
        ? item.stacktrace.frames
        : null;
      if (frames) out.stacktrace = { frames: frames.map(permitirFrame) };
      return out;
    }),
  };
}

export function permitirBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== 'object') return null;
  if (breadcrumb.category === 'console' || breadcrumb.type === 'http' && breadcrumb.category === 'console') {
    return null;
  }
  if (String(breadcrumb.category || '').startsWith('console')) return null;
  const out = {};
  if (breadcrumb.type != null) out.type = breadcrumb.type;
  if (breadcrumb.category != null) out.category = breadcrumb.category;
  if (breadcrumb.level != null) out.level = breadcrumb.level;
  if (breadcrumb.timestamp != null) out.timestamp = breadcrumb.timestamp;
  if (typeof breadcrumb.message === 'string') {
    out.message = redigirString(urlOrigemCaminho(breadcrumb.message));
  }
  return out;
}

function listaBreadcrumbs(breadcrumbs) {
  if (Array.isArray(breadcrumbs)) return breadcrumbs;
  if (breadcrumbs && Array.isArray(breadcrumbs.values)) return breadcrumbs.values;
  return [];
}

function permitirMensagem(message) {
  if (typeof message === 'string') return redigirString(message);
  if (!message || typeof message !== 'object') return message;
  const out = {};
  if (typeof message.message === 'string') out.message = redigirString(message.message);
  if (typeof message.formatted === 'string') out.formatted = redigirString(message.formatted);
  return out;
}

function entradasDeAtributos(attributes) {
  if (!attributes || typeof attributes !== 'object') return [];
  if (typeof attributes.entries === 'function' && !Array.isArray(attributes)) {
    try { return [...attributes.entries()]; } catch { /* objeto comum */ }
  }
  return Object.entries(attributes);
}

function limparAtributos(attributes) {
  const out = {};
  for (const [chave, valor] of entradasDeAtributos(attributes)) {
    if (chave === 'sentry.origin' || chave === 'sentry.op' || chave === 'sentry.sample_rate'
      || chave === 'sentry.kind' || chave === 'sentry.segment.name.source') {
      out[chave] = valor;
      continue;
    }
    if (CHAVES_ATRIBUTO_DESCARTAR.test(chave)) continue;
    if (typeof valor === 'string' && CHAVES_URL.test(chave)) {
      out[chave] = redigirString(urlOrigemCaminho(valor));
      continue;
    }
    if (typeof valor === 'string') out[chave] = redigirString(valor);
    else if (typeof valor === 'number' || typeof valor === 'boolean') out[chave] = valor;
  }
  return out;
}

function ehSpanStreamed(span) {
  if (span.attributes != null) return true;
  return span.name != null && span.description == null && span.data == null && span.op == null;
}

export function limparSpan(span) {
  if (!span || typeof span !== 'object') return span;
  if (ehSpanStreamed(span)) {
    const out = {
      trace_id: span.trace_id,
      span_id: span.span_id,
      start_timestamp: span.start_timestamp,
      status: span.status,
      is_segment: span.is_segment,
      attributes: limparAtributos(span.attributes),
    };
    if (span.parent_span_id != null) out.parent_span_id = span.parent_span_id;
    if (span.end_timestamp != null) out.end_timestamp = span.end_timestamp;
    out.name = typeof span.name === 'string' ? limparTextoLivre(span.name) : span.name;
    return out;
  }
  const out = {};
  for (const chave of ['span_id', 'trace_id', 'parent_span_id', 'op', 'origin', 'status', 'start_timestamp', 'timestamp']) {
    if (span[chave] !== undefined) out[chave] = span[chave];
  }
  if (typeof span.description === 'string') out.description = limparTextoLivre(span.description);
  if (span.data && typeof span.data === 'object') out.data = limparAtributos(span.data);
  return out;
}

export function permitirEvento(event) {
  if (!event || typeof event !== 'object') return event;
  const out = {};
  copiarTransporte(event, out);
  if (typeof event.transaction === 'string') out.transaction = limparTextoLivre(event.transaction);
  if (event.message != null) out.message = permitirMensagem(event.message);
  if (event.exception) out.exception = permitirExcecao(event.exception);
  if (event.threads) out.threads = permitirExcecao(event.threads);
  if (event.request) out.request = permitirRequest(event.request);
  if (event.user && typeof event.user === 'object') {
    const id = idSeguro(event.user.id);
    if (id) out.user = { id };
  }
  if (event.tags) out.tags = permitirMapa(event.tags);
  if (event.contexts) out.contexts = permitirContextos(event.contexts);
  if (event.breadcrumbs) {
    const lista = listaBreadcrumbs(event.breadcrumbs)
      .map(permitirBreadcrumb)
      .filter(Boolean);
    out.breadcrumbs = Array.isArray(event.breadcrumbs) ? lista : { values: lista };
  }
  if (Array.isArray(event.spans)) out.spans = event.spans.map(limparSpan);
  return out;
}
