# Frontend estático — build reproduzível para Coolify (FIL-92, P0.3).
# Multi-stage: build Vite em Node, serve os estáticos com Nginx.
FROM node:24-bookworm-slim AS build
WORKDIR /app

# VITE_* só existem embutidas no bundle (variáveis públicas, sem segredo) —
# precisam ser build arg porque o Vite resolve import.meta.env em build
# time, não em runtime.
ARG VITE_API_URL
ARG VITE_COMERCIAL_EMAIL
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_COMERCIAL_EMAIL=${VITE_COMERCIAL_EMAIL}

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# FIL-113 — marcador da build, servido em /version.json. Mesmo formato do campo
# `versao` de /health/* da API (server/versao.js), para haver um contrato só.
#
# O frontend de staging fica atrás do Cloudflare Access sem exceção de caminho,
# então o smoke automático NÃO alcança este arquivo lá — a limitação está
# declarada no `deploy-staging.yml` e em docs/AMBIENTES.md, e continua sendo
# limitação, não sucesso implícito. O marcador existe assim mesmo porque serve
# a dois consumidores reais: a validação humana em staging (o navegador já passa
# pelo Access) e o smoke de PRODUÇÃO do FIL-101, onde o domínio é público.
#
# Depois do `npm ci`/`npm run build`: não invalida a camada de dependências.
ARG OLUME_COMMIT_SHA=""
RUN node scripts/gerar-version-json.mjs dist/version.json

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:80/ || exit 1
