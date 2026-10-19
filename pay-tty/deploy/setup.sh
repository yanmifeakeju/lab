#!/usr/bin/env bash

# Migrates plane's database and seeds both. Runs on every `docker compose up`,
# after the ledger's own migrations: every step is idempotent, so a database
# that is already set up is left as it is.

set -euo pipefail

: "${LEDGER_DATABASE_URL:?LEDGER_DATABASE_URL is not set}"
: "${PLANE_DATABASE_URL:?PLANE_DATABASE_URL is not set}"

cd /app

DATABASE_URL=$LEDGER_DATABASE_URL ledger/scripts/seed.sh

cd packages/core
DATABASE_URL=$PLANE_DATABASE_URL pnpm exec drizzle-kit migrate
DATABASE_URL=$PLANE_DATABASE_URL scripts/seed.sh
