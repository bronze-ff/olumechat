// auth/middleware.js — Verifica JWT + checa jti-blacklist (padrão web MC).
const jwt = require('jsonwebtoken');
const blacklist = require('../utils/tokenBlacklist');
const { SECRET } = require('./secret');

module.exports = function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não informado' });
  }
  const token = header.slice(7);
  try {
    // algorithms travado em HS256 — impede confusão de algoritmo (ex.: "none").
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    if (decoded.jti && blacklist.has(decoded.jti)) {
      return res.status(401).json({ error: 'Sessão encerrada. Faça login novamente.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
};
