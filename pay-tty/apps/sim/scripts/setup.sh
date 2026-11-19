#!/usr/bin/env bash

# Creates the database in SIM_DATABASE_URL if it is missing, then migrates it.
# Refuses anything but a local database.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"

if [[ -z ${SIM_DATABASE_URL:-} && -f "$project_dir/.env" ]]; then
	set -a
	# shellcheck disable=SC1091
	source "$project_dir/.env"
	set +a
fi

if [[ -z ${SIM_DATABASE_URL:-} ]]; then
	printf 'SIM_DATABASE_URL is not set\n' >&2
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
	' "$SIM_DATABASE_URL"
)
host=${parts[0]}
database=${parts[1]}
maintenance_url=${parts[2]}

case $host in
localhost | 127.0.0.1 | ::1 | '[::1]') ;;
*)
	printf 'refusing to set up %s on %s: not a local database\n' "$database" "$host" >&2
	exit 1
	;;
esac

psql "$maintenance_url" -X -v ON_ERROR_STOP=1 -q -v db="$database" <<'SQL'
	SELECT format('CREATE DATABASE %I', :'db')
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SQL

cd "$project_dir"
pnpm exec drizzle-kit migrate
