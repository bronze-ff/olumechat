// utils/corsApi.js — CORS estrito da API quando o frontend está na Vercel e
// o backend em api.<domínio>. A Meta e chamadas server-to-server normalmente
// não enviam Origin e não passam por esta restrição de navegador.
'use strict';

function normalizarOrigem(valor) {
  if (!valor) return null;
  try {
    const url = new URL(String(valor).trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function origensPermitidas({ appUrl, corsOrigins, nodeEnv } = {}) {
  const valores = [
    appUrl,
    ...String(corsOrigins || '').split(','),
  ];

  if (nodeEnv !== 'production') {
    valores.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }

  return new Set(valores.map(normalizarOrigem).filter(Boolean));
}

function criarCorsApi(opcoes = {}) {
  const permitidas = origensPermitidas(opcoes);
  if (opcoes.nodeEnv === 'production' && permitidas.size === 0) {
    throw new Error('[cors] APP_URL/CORS_ORIGINS ausentes em produção');
  }

  return function corsApi(req, res, next) {
    const origem = normalizarOrigem(req.get('origin'));

    // curl, webhook e comunicação entre serviços não são requisições CORS.
    if (!origem) return next();

    res.vary('Origin');
    if (!permitidas.has(origem)) {
      return res.status(403).json({ error: 'Origem não permitida' });
    }

    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  };
}

module.exports = { criarCorsApi, normalizarOrigem, origensPermitidas };
