#!/usr/bin/env bash

# Drops and recreates the ledger's, plane's and the sim's databases, or only
# the ones named, then migrates them and seeds the ledger and plane with
# seed.sh's defaults. Migrations are rewritten before launch, so a fresh
# database is the only safe way onto a new one.
#
# Refuses anything but a local database.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd -- "$script_dir/../.." && pwd)"
# shellcheck disable=SC1091
source "$script_dir/lib.sh"

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
    printf 'usage: %s [ledger] [plane] [sim]\n' "$0" >&2
    exit 0
fi

targets=()
parse_targets "ledger plane sim" "$@"

require_psql

# Drops and recreates the database in the URL.
recreate() {
    local url=$1 parts host database maintenance_url
    # The host, the database name, and the URL of the maintenance database on
    # the same server, one per line.
    mapfile -t parts < <(
        node -e '
			const url = new URL(process.argv[1])
			console.log(url.hostname)
			console.log(decodeURIComponent(url.pathname.slice(1)))
			url.pathname = "/postgres"
			console.log(url.href)
        ' "$url"
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
}

reset_ledger() {
    local url
    url="$(database_url LEDGER_DATABASE_URL)"
    recreate "$url"
    (cd "$root_dir/ledger" && DATABASE_URL=$url go run ./cmd/migrate up)
    LEDGER_DATABASE_URL=$url "$script_dir/seed.sh" ledger
}

reset_plane() {
    local url
    url="$(database_url PLANE_DATABASE_URL)"
    recreate "$url"
    (cd "$root_dir/packages/core" && PLANE_DATABASE_URL=$url pnpm exec drizzle-kit migrate)
    PLANE_DATABASE_URL=$url "$script_dir/seed.sh" plane
}

reset_sim() {
    local url
    url="$(database_url SIM_DATABASE_URL)"
    recreate "$url"
    (cd "$root_dir/apps/sim" && SIM_DATABASE_URL=$url pnpm exec drizzle-kit migrate)
}

for target in "${targets[@]}"; do
    "reset_$target"
done
