// server/ia/client.js — adaptadores de provedor de IA (sem SDK, fetch cru).
// 'anthropic' → Messages API nativa. Demais → Chat Completions (OpenAI-compat:
// OpenAI, OpenRouter, Ollama, vLLM, Groq — trocando baseUrl + apiKey).
'use strict';
const { schemasParaProvedor } = require('./tools');

// FIL-85: o schema deixou de ser global. `ferramentas` chega PRONTO do runtime
// (montado por tenant em ia/ferramentasStore + ia/operacoes: ferramenta ligada,
// tags da empresa como enum, campos do template do pedido). Sem o argumento cai
// no registro estático — é o que os chamadores antigos e os testes recebem.
function schemasOu(ferramentas) {
  return Array.isArray(ferramentas) ? ferramentas : schemasParaProvedor();
}

function toolsAnthropic(ferramentas) {
  return schemasOu(ferramentas).map((s) => ({
    name: s.nome, description: s.descricao,
    input_schema: { type: 'object', properties: s.propriedades, required: s.obrigatorios },
  }));
}
function toolsOpenAI(ferramentas) {
  return schemasOu(ferramentas).map((s) => ({
    type: 'function',
    function: { name: s.nome, description: s.descricao,
      parameters: { type: 'object', properties: s.propriedades, required: s.obrigatorios } },
  }));
}

// ---- tradução do histórico neutro para cada provedor ----
function msgsAnthropic(mensagens) {
  const out = [];
  for (const m of mensagens) {
    if (m.papel === 'user') {
      // FIL-84: turno com imagem vira lista de blocos; sem imagem continua
      // string simples (o formato que o provedor já recebia — nada muda para
      // quem nunca mandou foto).
      if (m.imagem) {
        out.push({ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: m.imagem.mime, data: m.imagem.base64 } },
          { type: 'text', text: m.texto || '.' },
        ] });
      } else {
        out.push({ role: 'user', content: m.texto || '.' });
      }
      continue;
    }
    if (m.papel === 'assistant') {
      const content = [];
      if (m.texto) content.push({ type: 'text', text: m.texto });
      if (m.toolCallId) content.push({ type: 'tool_use', id: m.toolCallId, name: m.nome, input: m.args || {} });
      if (!content.length) continue; // NUNCA envia content:[] — Anthropic rejeita (400)
      out.push({ role: 'assistant', content });
      continue;
    }
    // tool result
    out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: typeof m.resultado === 'string' ? m.resultado : JSON.stringify(m.resultado) }] });
  }
  return out;
}
function msgsOpenAI(sistema, mensagens) {
  const out = [{ role: 'system', content: sistema }];
  for (const m of mensagens) {
    if (m.papel === 'user') {
      // FIL-84: OpenAI recebe imagem como data URI em `image_url` — formato
      // DIFERENTE do bloco `source.base64` da Anthropic. Errar aqui é 400 do
      // provedor, que o runtime transforma em fallback genérico: o cliente
      // nunca saberia por quê.
      if (m.imagem) {
        out.push({ role: 'user', content: [
          { type: 'text', text: m.texto || '.' },
          { type: 'image_url', image_url: { url: `data:${m.imagem.mime};base64,${m.imagem.base64}` } },
        ] });
      } else {
        out.push({ role: 'user', content: m.texto || '.' });
      }
      continue;
    }
    if (m.papel === 'assistant') {
      const toolCalls = m.toolCallId
        ? [{ id: m.toolCallId, type: 'function', function: { name: m.nome, arguments: JSON.stringify(m.args || {}) } }]
        : undefined;
      if (!m.texto && !toolCalls) continue; // assistant sem texto E sem tool = inválido
      out.push({ role: 'assistant', content: m.texto || null, tool_calls: toolCalls });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: typeof m.resultado === 'string' ? m.resultado : JSON.stringify(m.resultado ?? '') });
    }
  }
  return out;
}

const TIMEOUT_MS = 45_000;
// Timeout nas chamadas ao provedor: sem isto, um provedor pendurado prende a
// conexão Oracle do runtime indefinidamente e ajuda a esgotar o pool (NJS-040).
async function fetchComTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  catch (e) { if (e && e.name === 'AbortError') throw new Error(`Provedor sem resposta em ${TIMEOUT_MS}ms (timeout)`); throw e; }
  finally { clearTimeout(t); }
}

// `semFerramentas`: usos leves (sugestão de resposta, sentimento, correção de
// texto) não devem ganhar acesso às tools do bot (consulta de cliente/cobrança)
// nem pagar o custo de descrevê-las a cada chamada — só o runtime do bot precisa.
async function chamar({ config, sistema, mensagens, semFerramentas = false, ferramentas }) {
  if (config.provider === 'anthropic') {
    const body = { model: config.modelo, max_tokens: 1024, system: sistema, messages: msgsAnthropic(mensagens) };
    if (!semFerramentas) body.tools = toolsAnthropic(ferramentas);
    const res = await fetchComTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Provedor anthropic ${res.status}: ${JSON.stringify((await res.json().catch(() => ({}))).error || {})}`);
    const json = await res.json();
    const texto = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const toolCalls = (json.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, nome: b.name, args: b.input || {} }));
    return { texto, toolCalls, uso: extrairUso(json.usage, 'input_tokens', 'output_tokens') };
  }
  // OpenAI-compatível
  const base = (config.baseUrl || '').replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  const body = { model: config.modelo, messages: msgsOpenAI(sistema, mensagens) };
  if (!semFerramentas) body.tools = toolsOpenAI(ferramentas);
  const res = await fetchComTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Provedor ${config.provider} ${res.status}: ${JSON.stringify((await res.json().catch(() => ({}))).error || {})}`);
  const json = await res.json();
  const msg = ((json.choices || [])[0] || {}).message || {};
  const toolCalls = (msg.tool_calls || []).map((c) => ({ id: c.id, nome: c.function.name, args: safeJson(c.function.arguments) }));
  return { texto: msg.content || '', toolCalls, uso: extrairUso(json.usage, 'prompt_tokens', 'completion_tokens') };
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

// Uso real de tokens que o PROVEDOR devolveu na resposta (nunca estimado por
// caractere — ver consumo/registrar.js, FIL-77). `null` quando o provedor não
// devolveu `usage` (alguns proxies OpenAI-compatíveis omitem) — quem chama
// trata como "nada a medir nesta chamada", nunca inventa um número.
function extrairUso(usage, campoEntrada, campoSaida) {
  if (!usage) return null;
  return {
    tokensEntrada: Number(usage[campoEntrada]) || 0,
    tokensSaida: Number(usage[campoSaida]) || 0,
  };
}

module.exports = { chamar };
