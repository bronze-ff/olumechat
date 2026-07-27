#!/bin/sh
set -eu

# Render injects DATABASE_URL as a secret. Use the direct Neon URL for DDL when
# MIGRATION_DATABASE_URL is configured; the app itself uses the pooled URL.
cd /app/server
npm run migrar
exec node app.js
