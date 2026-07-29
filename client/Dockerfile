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

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:80/ || exit 1
