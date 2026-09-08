#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"

usage() {
	printf 'usage: %s --reset\n' "$0" >&2
}

if [[ ${1:-} != "--reset" || $# -ne 1 ]]; then
	usage
	exit 2
fi

if [[ -z ${DATABASE_URL:-} && -f "$project_dir/.env" ]]; then
	set -a
	# shellcheck disable=SC1091
	source "$project_dir/.env"
	set +a
fi

if [[ -z ${DATABASE_URL:-} ]]; then
	printf 'DATABASE_URL is not set\n' >&2
	exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
	printf 'psql is required to reset the database\n' >&2
	exit 1
fi

database_name="$(
	psql "$DATABASE_URL" \
		-X \
		-v ON_ERROR_STOP=1 \
		-A \
		-t \
		-c 'SELECT current_database()'
)"

printf 'resetting database %q\n' "$database_name"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
COMMIT;
SQL

printf 'database %q schema reset successfully\n' "$database_name"
