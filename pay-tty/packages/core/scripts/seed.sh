#!/usr/bin/env bash

# Seeds catalog ledgers, with the currency and scale the ledger service fixes
# for each, and their platform accounts: the `cash` and `fee` refs shared by
# every business in that ledger. Without --slug it seeds `ngn_ng`, in NGN, as
# Nigeria's default: the ledger every new NG business is created in. No other
# country has a default, so creating a business there fails until one is
# seeded. --country makes a --slug ledger its country's default; that choice
# is plane's alone, so the ledger service has no equivalent.
#
# The ledger has no API that exposes platform accounts. They are seeded
# directly into its database by ledger/scripts/seed.sh, so plane cannot
# discover or create them and the refs are copied in here. The defaults are
# derived exactly as that script derives them, so both seeds agree on a fresh
# setup without passing anything.
#
# Re-running is idempotent: an existing ledger or account is kept, not
# overwritten. An existing ledger that disagrees with what was asked for is an
# error, not something to fix in place.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"

ledger_slug=
currency=
scale=
country=
cash_ref=
fee_ref=

usage() {
	printf 'usage: %s [--slug SLUG --currency XXX [--scale N] [--country CC] [--cash ACCT_REF] [--fee ACCT_REF]]\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
	case $1 in
	--slug | --currency | --scale | --country | --cash | --fee)
		[[ $# -ge 2 ]] || { usage; exit 2; }
		case $1 in
		--slug) ledger_slug=$2 ;;
		--currency) currency=$2 ;;
		--scale) scale=$2 ;;
		--country) country=$2 ;;
		--cash) cash_ref=$2 ;;
		--fee) fee_ref=$2 ;;
		esac
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

if [[ -z $ledger_slug && -n $currency$scale$country$cash_ref$fee_ref ]]; then
	printf 'ledger options need --slug\n' >&2
	usage
	exit 2
fi

if [[ -n $ledger_slug && -z $currency ]]; then
	printf '%s needs --currency\n' "$ledger_slug" >&2
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
		-c "SELECT to_regclass('public.platform_accounts') IS NOT NULL"
)"
if [[ $table_exists != "t" ]]; then
	printf 'the platform_accounts table is missing; run pnpm db:migrate first\n' >&2
	exit 1
fi

# Mirrors ledger/scripts/seed.sh. The ledger labels the fee account
# `fee_revenue`; plane calls the same account `fee`.
ledger_ref() {
	printf 'acct_0%s' "$(printf '%s:%s' "$1" "$2" | md5sum | cut -c1-25 | tr '[:lower:]' '[:upper:]')"
}

# slug currency scale country cash fee; empty scale, cash, or fee are derived.
seed_ledger() {
	local slug=$1 currency=$2 scale=$3 country=$4 cash=$5 fee=$6

	if [[ -z $slug || $slug =~ [[:space:]] ]]; then
		printf 'invalid slug %q: must be non-blank\n' "$slug" >&2
		exit 2
	fi

	# The scale must match the ledger's own; without --scale it falls back to
	# the currency's ISO 4217 exponent, which is also what
	# ledger/scripts/seed.sh uses.
	local iso_exponent
	iso_exponent="$(
		node --input-type=module -e '
			const { exponents } = await import(process.argv[1])
			console.log(exponents[process.argv[2]] ?? "")
		' "$project_dir/src/ledger/currency.ts" "$currency"
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

	if [[ -n $country && ! $country =~ ^[A-Z]{2}$ ]]; then
		printf 'invalid country %q: must be a 2-letter ISO 3166 code\n' "$country" >&2
		exit 2
	fi

	cash=${cash:-$(ledger_ref "$slug" cash)}
	fee=${fee:-$(ledger_ref "$slug" fee_revenue)}

	for ref in "$cash" "$fee"; do
		if [[ ! $ref =~ ^acct_[0-9A-Z]{26}$ ]]; then
			printf 'invalid account ref %q: must be acct_ followed by 26 characters\n' "$ref" >&2
			exit 2
		fi
	done

	psql "$DATABASE_URL" \
		-X \
		-v ON_ERROR_STOP=1 \
		-q \
		-v slug="$slug" \
		-v currency="$currency" \
		-v scale="$scale" \
		-v country="$country" \
		-v cash="$cash" \
		-v fee="$fee" \
		<<'SQL'
		INSERT INTO ledgers (slug, currency, scale, country_code, is_country_default)
		VALUES (:'slug', :'currency', :'scale', nullif(:'country', ''), :'country' <> '')
		ON CONFLICT (slug) DO NOTHING;

		INSERT INTO platform_accounts (ledger, label, ledger_account_ref)
		VALUES (:'slug', 'cash', :'cash'), (:'slug', 'fee', :'fee')
		ON CONFLICT (ledger, label) DO NOTHING;
SQL

	# A kept row must still be what was asked for.
	local stored expected
	stored="$(
		psql "$DATABASE_URL" \
			-X \
			-v ON_ERROR_STOP=1 \
			-A \
			-t \
			-F ' ' \
			-v slug="$slug" \
			<<'SQL'
			SELECT currency, scale, coalesce(country_code, '-'), is_country_default
			FROM ledgers
			WHERE slug = :'slug';
SQL
	)"
	expected="$currency $scale ${country:--} $([[ -n $country ]] && printf t || printf f)"
	if [[ $stored != "$expected" ]]; then
		printf 'ledger %s exists as (%s), not (%s)\n' "$slug" "$stored" "$expected" >&2
		exit 1
	fi
}

if [[ -n $ledger_slug ]]; then
	seed_ledger "$ledger_slug" "$currency" "$scale" "$country" "$cash_ref" "$fee_ref"
else
	seed_ledger ngn_ng NGN "" NG "" ""
fi

psql "$DATABASE_URL" \
	-X \
	-v ON_ERROR_STOP=1 \
	-A \
	-t \
	-F ' ' \
	-c "SELECT l.slug, l.currency, l.scale, coalesce(l.country_code, '-'), l.is_country_default, a.label, a.ledger_account_ref FROM ledgers l JOIN platform_accounts a ON a.ledger = l.slug ORDER BY l.slug, a.label" |
	while read -r ledger currency scale country is_default label reference; do
		printf 'ledger %s (%s, scale %s, country %s, default %s) platform account %s (%s)\n' \
			"$ledger" "$currency" "$scale" "$country" "$is_default" "$label" "$reference"
	done
