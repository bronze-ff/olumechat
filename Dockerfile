# Backend persistente. O frontend é publicado em container separado (client/Dockerfile).
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server

COPY --chown=node:node server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server/ ./
RUN chmod +x docker-entrypoint.sh

# FIL-113 — o SHA do commit que originou ESTA imagem, gravado no build. É o que
# `server/versao.js` lê para expor `versao` em /health/*, e é o que permite ao
# smoke de deploy provar a versão SERVIDA (e não só que alguém respondeu 200).
#
# Arquivo, não `ENV`: variável de ambiente é configuração do Coolify — editável
# e copiada à mão entre aplicações —, e um marcador de versão que pode ser
# declarado por fora do build pode mentir. Ver o cabeçalho de server/versao.js.
#
# Fora de `WORKDIR` (/app/server) porque o `COPY server/ ./` acima sobrescreve
# aquele diretório; aqui a camada não depende da ordem para sobreviver. E depois
# do `npm ci` de propósito: um valor diferente a cada commit não invalida a
# camada de dependências.
#
# Sem o build-arg o arquivo sai vazio e /health/* reporta `origem:
# "desconhecida"` — build local continua funcionando, e quem EXIGE o marcador é
# a CI (job `backend-image`), que falha se a resposta não trouxer o SHA do commit.
ARG OLUME_COMMIT_SHA=""
RUN printf '%s' "${OLUME_COMMIT_SHA}" > /app/BUILD_SHA

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||10000)+'/health/ready', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER node
ENTRYPOINT ["./docker-entrypoint.sh"]
