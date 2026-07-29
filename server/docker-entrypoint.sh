#!/bin/sh
# FIL-92 (P0.4): roda a migração ANTES do node subir — o boot falha (exit
# != 0, por causa do `set -e`) se a migração falhar, então o container nunca
# chega a ficar ready com uma versão de banco incompleta.
set -e

echo "[entrypoint] aplicando migracoes..."
npm run migrar

echo "[entrypoint] migracoes concluidas, iniciando o servidor..."
exec node app.js
