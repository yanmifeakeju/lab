#!/usr/bin/env bash

# Runs once, when the Postgres volume is first created: one role and one
# database each for plane and the ledger, so neither can read the other's.

set -euo pipefail

psql --username "$POSTGRES_USER" --dbname postgres -X -v ON_ERROR_STOP=1 -q \
	-v plane_password="$PLANE_DB_PASSWORD" \
	-v ledger_password="$LEDGER_DB_PASSWORD" <<'SQL'
	CREATE ROLE plane LOGIN PASSWORD :'plane_password';
	CREATE DATABASE plane OWNER plane;
	REVOKE ALL ON DATABASE plane FROM PUBLIC;

	CREATE ROLE ledger LOGIN PASSWORD :'ledger_password';
	CREATE DATABASE ledger OWNER ledger;
	REVOKE ALL ON DATABASE ledger FROM PUBLIC;
SQL
