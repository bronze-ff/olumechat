// server/ia/anexos.js — política de reanexo de imagem no histórico da IA.
//
// O turno guarda o CAMINHO no storage, nunca os bytes (ver a migração 021). A
// cada mensagem o histórico inteiro é recarregado e reenviado ao provedor —
// sem teto, uma conversa com dez fotos reenviaria as dez a CADA turno: custo
// quadrático em cima do item mais caro do prompt.
//
// REGRA: só as 2 imagens MAIS RECENTES voltam de verdade. As anteriores viram
// uma linha de texto dizendo que existiram — o modelo continua sabendo que
// houve uma foto ali, sem pagar por ela de novo. Gatilho para reconsiderar o
// número 2: reclamação de contexto visual perdido.
'use strict';

const { storage } = require('../storage');
const { MIMES_IMAGEM } = require('./entrada');

const LIMITE_REANEXOS = 2;
const PLACEHOLDER = '[imagem enviada anteriormente]';

function ehImagem(mime) {
  return MIMES_IMAGEM.has(String(mime || '').split(';')[0].toLowerCase());
}

/** As ≤2 imagens mais recentes do cliente, sem repetir caminho. PURA. */
function selecionar(mensagens) {
  const vistos = new Set();
  const sel = [];
  for (let i = (mensagens || []).length - 1; i >= 0 && sel.length < LIMITE_REANEXOS; i -= 1) {
    const m = mensagens[i];
    if (!m || m.papel !== 'user' || !m.midiaCaminho || !ehImagem(m.midiaMime)) continue;
    if (vistos.has(m.midiaCaminho)) continue;
    vistos.add(m.midiaCaminho);
    sel.push({ caminho: m.midiaCaminho, mime: String(m.midiaMime).split(';')[0].toLowerCase() });
  }
  return sel;
}

/**
 * Lê os bytes das imagens selecionadas. Caminho que falhar (arquivo removido,
 * storage fora do ar) simplesmente NÃO entra no mapa — vira placeholder no
 * `aplicar`. Uma foto ilegível não pode derrubar o turno inteiro.
 * @returns {Promise<Map<string, {mime: string, base64: string}>>}
 */
async function carregarImagens(selecao) {
  const mapa = new Map();
  for (const item of selecao || []) {
    try {
      const buf = await storage.ler(item.caminho);
      mapa.set(item.caminho, { mime: item.mime, base64: Buffer.from(buf).toString('base64') });
    } catch (err) {
      console.error(`[ia] imagem ${item.caminho} não pôde ser lida (segue como placeholder):`, err.message);
    }
  }
  return mapa;
}

/**
 * Hidrata o histórico: turno selecionado E com bytes no cache ganha
 * `imagem: {mime, base64}`; os demais turnos com imagem perdem a mídia e
 * ganham o placeholder no texto (sem apagar a legenda original). PURA.
 */
function aplicar(mensagens, cache) {
  return (mensagens || []).map((m) => {
    if (!m || m.papel !== 'user' || !m.midiaCaminho || !ehImagem(m.midiaMime)) return m;
    const bytes = cache && cache.get(m.midiaCaminho);
    if (bytes) return { ...m, imagem: { mime: bytes.mime, base64: bytes.base64 } };
    const texto = m.texto ? `${PLACEHOLDER} ${m.texto}` : PLACEHOLDER;
    return { ...m, texto, imagem: undefined };
  });
}

module.exports = { LIMITE_REANEXOS, PLACEHOLDER, selecionar, carregarImagens, aplicar };
