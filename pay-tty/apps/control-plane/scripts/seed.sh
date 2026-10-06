#!/usr/bin/env bash

# Seeds one ledger, with the currency and scale the ledger service fixes for
# it, and its platform accounts: the refs every business's session uses for
# `cash` and `fee` in that ledger.
#
# This exists because the ledger has no API that exposes platform accounts.
# They are seeded directly into its database by ledger/scripts/seed.sh, so the
# control plane cannot discover or create them and the refs are copied in
# here. The defaults are derived exactly as that script derives them, so both
# seeds agree on a fresh setup without passing anything.
#
# Delete this once the ledger's admin /ledgers API lands: the control plane
# will then fill both tables from it at startup, creating any missing platform
# account. See ledger/doc/tasks/2026-09-15-rotate-platform-accounts.md.
#
# Re-running is idempotent: an existing ledger or account is kept, not
# overwritten.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"

ledger_slug=ngn_ng
currency=NGN
scale=
cash_ref=
fee_ref=

usage() {
	printf 'usage: %s [--slug SLUG] [--currency XXX] [--scale N] [--cash ACCT_REF] [--fee ACCT_REF]\n' "$0" >&2
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
	--cash)
		[[ $# -ge 2 ]] || { usage; exit 2; }
		cash_ref=$2
		shift 2
		;;
	--fee)
		[[ $# -ge 2 ]] || { usage; exit 2; }
		fee_ref=$2
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

# The scale must match the ledger's own; without --scale it falls back to the
# currency's ISO 4217 exponent, which is also what ledger/scripts/seed.sh uses
# for NGN.
iso_exponent="$(
	node --input-type=module -e '
		const { exponents } = await import(process.argv[1])
		console.log(exponents[process.argv[2]] ?? "")
	' "$project_dir/src/core/ledger/currency.ts" "$currency"
)"
if [[ -z $iso_exponent ]]; then
	printf 'invalid currency %q: must be an ISO 4217 code\n' "$currency" >&2
	exit 2
fi
scale=${scale:-$iso_exponent}
if [[ ! $scale =~ ^[0-4]$ ]]; then
	printf 'invalid scale %q: must be an integer between 0 and 4\n' "$scale" >&2
	exit 2
fi

# Mirrors ledger/scripts/seed.sh. The ledger labels the fee account
# `fee_revenue`; the control plane calls the same account `fee`.
ledger_ref() {
	printf 'acct_0%s' "$(printf '%s:%s' "$ledger_slug" "$1" | md5sum | cut -c1-25 | tr '[:lower:]' '[:upper:]')"
}

cash_ref=${cash_ref:-$(ledger_ref cash)}
fee_ref=${fee_ref:-$(ledger_ref fee_revenue)}

for ref in "$cash_ref" "$fee_ref"; do
	if [[ ! $ref =~ ^acct_[0-9A-Z]{26}$ ]]; then
		printf 'invalid account ref %q: must be acct_ followed by 26 characters\n' "$ref" >&2
		exit 2
	fi
done

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
		-c "SELECT to_regclass('public.platform_accounts') IS NOT NULL"
)"
if [[ $table_exists != "t" ]]; then
	printf 'the platform_accounts table is missing; run pnpm db:migrate first\n' >&2
	exit 1
fi

psql "$DATABASE_URL" \
	-X \
	-v ON_ERROR_STOP=1 \
	-q \
	-v slug="$ledger_slug" \
	-v currency="$currency" \
	-v scale="$scale" \
	-v cash="$cash_ref" \
	-v fee="$fee_ref" \
	<<'SQL'
	INSERT INTO ledgers (slug, currency, scale)
	VALUES (:'slug', :'currency', :'scale')
	ON CONFLICT (slug) DO NOTHING;

	INSERT INTO platform_accounts (ledger, label, ledger_account_ref)
	VALUES (:'slug', 'cash', :'cash'), (:'slug', 'fee', :'fee')
	ON CONFLICT (ledger, label) DO NOTHING;
SQL

psql "$DATABASE_URL" \
	-X \
	-v ON_ERROR_STOP=1 \
	-A \
	-t \
	-F ' ' \
	-c "SELECT l.slug, l.currency, l.scale, a.label, a.ledger_account_ref FROM ledgers l JOIN platform_accounts a ON a.ledger = l.slug ORDER BY l.slug, a.label" |
	while read -r ledger currency scale label reference; do
		printf 'ledger %s (%s, scale %s) platform account %s (%s)\n' "$ledger" "$currency" "$scale" "$label" "$reference"
	done
