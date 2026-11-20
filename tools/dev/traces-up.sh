#!/bin/sh
# pnpm traces:up: the Nestrix server (compose.dev.yaml, profile "traces"),
# with its own database in the development PostgreSQL, made when missing.
set -eu
# This project's ports (pnpm run setup --dev-ports), as docker compose reads them.
[ -f .env ] && . ./.env
compose="docker compose -f compose.dev.yaml"
$compose up -d --wait postgres
if ! $compose exec -T postgres psql -U app -d app -tAc \
  "select 1 from pg_database where datname = 'nestrix'" | grep -q 1; then
  $compose exec -T postgres createdb -U app nestrix
fi
$compose --profile traces up -d --wait nestrix
echo "Nestrix: http://localhost:${NESTRIX_PORT:-4318} (password: ${NESTRIX_ADMIN_PASSWORD:-nestrix-dev-password})."
echo "Traces from the API and worker: OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${NESTRIX_PORT:-4318} in apps/api/.env."
