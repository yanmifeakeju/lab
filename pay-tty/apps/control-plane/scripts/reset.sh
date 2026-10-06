#!/usr/bin/env bash

# Drops and recreates the database in DATABASE_URL, then migrates and seeds
# it. Migrations are rewritten before launch, so a fresh database is the only
# safe way onto a new one.
#
# Refuses anything but a local database. Arguments are passed to seed.sh.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"

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

# Prints the host, the database name, and the URL of the maintenance database
# on the same server, one per line.
mapfile -t parts < <(
	node -e '
		const url = new URL(process.argv[1])
		console.log(url.hostname)
		console.log(decodeURIComponent(url.pathname.slice(1)))
		url.pathname = "/postgres"
		console.log(url.href)
	' "$DATABASE_URL"
)
host=${parts[0]}
database=${parts[1]}
maintenance_url=${parts[2]}

case $host in
localhost | 127.0.0.1 | ::1 | '[::1]') ;;
*)
	printf 'refusing to reset %s on %s: not a local database\n' "$database" "$host" >&2
	exit 1
	;;
esac

if [[ -z $database || $database == postgres ]]; then
	printf 'refusing to reset database %q\n' "$database" >&2
	exit 1
fi

psql "$maintenance_url" -X -v ON_ERROR_STOP=1 -q -v db="$database" <<'SQL'
	SET client_min_messages = warning;
	DROP DATABASE IF EXISTS :"db" WITH (FORCE);
	CREATE DATABASE :"db";
SQL
printf 'recreated %s\n' "$database"

cd "$project_dir"
pnpm exec drizzle-kit migrate
"$script_dir/seed.sh" "$@"
