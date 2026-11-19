#!/usr/bin/env bash

# Migrates plane's and the sim's databases and seeds plane and the ledger.
# Runs on every `docker compose up`, after the ledger's own migrations: every
# step is idempotent, so a database that is already set up is left as it is.

set -euo pipefail

: "${LEDGER_DATABASE_URL:?LEDGER_DATABASE_URL is not set}"
: "${PLANE_DATABASE_URL:?PLANE_DATABASE_URL is not set}"
: "${SIM_DATABASE_URL:?SIM_DATABASE_URL is not set}"
: "${SIM_DB_PASSWORD:?SIM_DB_PASSWORD is not set}"
: "${POSTGRES_ADMIN_URL:?POSTGRES_ADMIN_URL is not set}"

cd /app

(cd packages/core && pnpm exec drizzle-kit migrate)
scripts/db/seed.sh

# Here rather than in postgres-init.sh, so a volume created before the sim
# existed gets it too. Only the sim service connects to it. The password is
# set every run, so changing SIM_DB_PASSWORD takes effect.
psql "$POSTGRES_ADMIN_URL" -X -v ON_ERROR_STOP=1 -q -v sim_password="$SIM_DB_PASSWORD" <<'SQL'
	SELECT 'CREATE ROLE sim'
	WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sim') \gexec
	ALTER ROLE sim WITH LOGIN PASSWORD :'sim_password';
	SELECT 'CREATE DATABASE sim OWNER sim'
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sim') \gexec
	REVOKE ALL ON DATABASE sim FROM PUBLIC;
SQL

cd apps/sim
pnpm exec drizzle-kit migrate
