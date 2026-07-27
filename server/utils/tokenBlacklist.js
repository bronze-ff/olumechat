// utils/tokenBlacklist.js — Blacklist de jti revogados (logout), em memória.
// Em deploy multi-instância, trocar por Redis SET com TTL = JWT_EXPIRES_IN.
const blacklist = new Set();

setInterval(() => {
  if (blacklist.size > 10000) blacklist.clear();
}, 60 * 60 * 1000).unref?.();

module.exports = blacklist;
