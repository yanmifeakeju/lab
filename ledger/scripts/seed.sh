#!/usr/bin/env bash

# Seeds one ledger and its platform accounts. Re-running the script is
# idempotent: existing rows are retained and any missing platform account is
# added.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"

ledger_slug=ngn_ng
currency=NGN
scale=2

usage() {
	printf 'usage: %s [--slug SLUG] [--currency XXX] [--scale N]\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
	case $1 in
	--slug)
		[[ $# -ge 2 ]] || { usage; exit 2; }
		ledger_slug=$2
		shift 2
		;;
	--currency)
		[[ $# -ge 2 ]] || { usage; exit 2; }
		currency=$2
		shift 2
		;;
	--scale)
		[[ $# -ge 2 ]] || { usage; exit 2; }
		scale=$2
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage
		exit 2
		;;
	esac
done

if [[ -z $ledger_slug || $ledger_slug =~ [[:space:]] ]]; then
	printf 'invalid slug %q: must be non-blank\n' "$ledger_slug" >&2
	exit 2
fi
if [[ ! $currency =~ ^[A-Z]{3}$ ]]; then
	printf 'invalid currency %q: must be a 3-letter ISO 4217 code\n' "$currency" >&2
	exit 2
fi
if [[ ! $scale =~ ^[0-4]$ ]]; then
	printf 'invalid scale %q: must be an integer between 0 and 4\n' "$scale" >&2
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
	printf 'psql is required to seed the database\n' >&2
	exit 1
fi

table_exists="$(
	psql "$DATABASE_URL" \
		-X \
		-v ON_ERROR_STOP=1 \
		-A \
		-t \
		-c "SELECT to_regclass('public.ledgers') IS NOT NULL"
)"
if [[ $table_exists != "t" ]]; then
	printf 'the ledgers table is missing; run make migrate-up first\n' >&2
	exit 1
fi

table_exists="$(
	psql "$DATABASE_URL" \
		-X \
		-v ON_ERROR_STOP=1 \
		-A \
		-t \
		-c "SELECT to_regclass('public.accounts') IS NOT NULL"
)"
if [[ $table_exists != "t" ]]; then
	printf 'the accounts table is missing; run make migrate-up first\n' >&2
	exit 1
fi

ledger_id="$(
	psql "$DATABASE_URL" \
		-X \
		-v ON_ERROR_STOP=1 \
		-q \
		-A \
		-t \
		-v slug="$ledger_slug" \
		-v currency="$currency" \
		-v scale="$scale" \
		<<'SQL'
		INSERT INTO ledgers (slug, currency, scale)
		VALUES (:'slug', :'currency', :'scale')
		ON CONFLICT (slug) DO NOTHING
		RETURNING id;
SQL
)"

if [[ -n $ledger_id ]]; then
	printf 'created ledger %s (id %s, currency %s, scale %s)\n' \
		"$ledger_slug" "$ledger_id" "$currency" "$scale"
else
	ledger_id="$(
		psql "$DATABASE_URL" \
			-X \
			-v ON_ERROR_STOP=1 \
			-A \
			-t \
			-v slug="$ledger_slug" \
			<<'SQL'
			SELECT id FROM ledgers WHERE slug = :'slug';
SQL
	)"
	printf 'ledger %s already seeded (id %s)\n' "$ledger_slug" "$ledger_id"
fi

psql "$DATABASE_URL" \
	-X \
	-v ON_ERROR_STOP=1 \
	-q \
	-v ledger_id="$ledger_id" \
	-v slug="$ledger_slug" \
	<<'SQL'
	WITH platform_accounts(kind, description) AS (
		VALUES
			('cash', 'Platform cash account'),
			('fee_revenue', 'Platform fee revenue account')
	)
	INSERT INTO accounts (public_ref, ledger_id, kind, description)
	SELECT
		'acct_0' || upper(substr(md5(:'slug' || ':' || kind), 1, 25)),
		:'ledger_id'::integer,
		kind,
		description
	FROM platform_accounts
	ON CONFLICT (ledger_id, kind) WHERE holder_id IS NULL
	DO NOTHING;
SQL

psql "$DATABASE_URL" \
	-X \
	-v ON_ERROR_STOP=1 \
	-A \
	-t \
	-F ' ' \
	-v ledger_id="$ledger_id" \
	<<'SQL' |
	SELECT kind, public_ref
	FROM accounts
	WHERE ledger_id = :'ledger_id'::integer
		AND holder_id IS NULL
	ORDER BY kind;
SQL
	while read -r kind reference; do
		printf 'seeded platform account %s (%s)\n' "$kind" "$reference"
	done
