#!/usr/bin/env bash

# Seeds a catalog ledger and its platform accounts (`cash`, `fee`, `receivable`,
# `payouts_clearing`) into the ledger's database and plane's, or only the ones
# named. Without --slug it seeds `ngn_ng`, in NGN, as Nigeria's default: the
# ledger every new NG business is created in. No other country has a default,
# so creating a business there fails until one is seeded. --country makes a
# --slug ledger its country's default; that choice is plane's alone.
#
# The ledger has no API that exposes platform accounts, so plane can't
# discover them. Both databases get refs derived from the slug and label, so
# they agree without either reading the other.
#
# Re-running is idempotent: an existing ledger or account is kept. An existing
# ledger that disagrees with what was asked for is an error, not something to
# fix in place.

set -euo pipefail

# shellcheck source=scripts/db/lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

usage() {
	printf 'usage: %s [ledger] [plane] [--slug SLUG --currency XXX [--scale N] [--country CC]]\n' "$0" >&2
}

slug=
currency=
scale=
country=
names=()
while [[ $# -gt 0 ]]; do
	case $1 in
	--slug | --currency | --scale | --country)
		[[ $# -ge 2 ]] || { usage; exit 2; }
		case $1 in
		--slug) slug=$2 ;;
		--currency) currency=$2 ;;
		--scale) scale=$2 ;;
		--country) country=$2 ;;
		esac
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		usage
		exit 2
		;;
	*)
		names+=("$1")
		shift
		;;
	esac
done

parse_targets "ledger plane" "${names[@]}"

if [[ -z $slug ]]; then
	if [[ -n $currency$scale$country ]]; then
		printf 'ledger options need --slug\n' >&2
		usage
		exit 2
	fi
	slug=ngn_ng currency=NGN country=NG
fi

if [[ -z $currency ]]; then
	printf '%s needs --currency\n' "$slug" >&2
	exit 2
fi
if [[ $slug =~ [[:space:]] ]]; then
	printf 'invalid slug %q: must be non-blank\n' "$slug" >&2
	exit 2
fi

# Without --scale, the currency's ISO 4217 exponent.
iso_exponent="$(
	node --input-type=module -e '
		const { exponents } = await import(process.argv[1])
		console.log(exponents[process.argv[2]] ?? "")
	' "$root_dir/packages/core/src/ledger/currency.ts" "$currency"
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

require_psql

# The ledger labels the fee account `fee_revenue`; plane calls it `fee`.
account_ref() {
	printf 'acct_0%s' "$(printf '%s:%s' "$slug" "$1" | md5sum | cut -c1-25 | tr '[:lower:]' '[:upper:]')"
}
cash=$(account_ref cash)
fee=$(account_ref fee_revenue)
receivable=$(account_ref receivable)
clearing=$(account_ref payouts_clearing)

# Fails when a kept ledger row isn't what was asked for.
check_stored() {
	local name=$1 stored=$2 expected=$3
	if [[ $stored != "$expected" ]]; then
		printf '%s: ledger %s exists as (%s), not (%s)\n' "$name" "$slug" "$stored" "$expected" >&2
		exit 1
	fi
}

seed_ledger() {
	local url stored
	url="$(database_url LEDGER_DATABASE_URL)"
	psql "$url" -X -v ON_ERROR_STOP=1 -q \
		-v slug="$slug" -v currency="$currency" -v scale="$scale" \
		-v cash="$cash" -v fee="$fee" -v receivable="$receivable" -v clearing="$clearing" \
		<<'SQL'
		INSERT INTO ledgers (slug, currency, scale)
		VALUES (:'slug', :'currency', :'scale')
		ON CONFLICT (slug) DO NOTHING;

		INSERT INTO accounts (public_ref, ledger_id, kind, label, description)
		SELECT a.ref, l.id, 'platform', a.label, a.description
		FROM ledgers l, (VALUES
			(:'cash', 'cash', 'Platform cash account'),
			(:'fee', 'fee_revenue', 'Platform fee revenue account'),
			(:'receivable', 'receivable', 'Platform receivable account'),
			(:'clearing', 'payouts_clearing', 'Payouts clearing account')
		) AS a(ref, label, description)
		WHERE l.slug = :'slug'
		ON CONFLICT (public_ref) DO NOTHING;
SQL
	stored="$(psql "$url" -X -v ON_ERROR_STOP=1 -A -t -F ' ' -v slug="$slug" <<'SQL'
		SELECT currency, scale FROM ledgers WHERE slug = :'slug';
SQL
	)"
	check_stored ledger "$stored" "$currency $scale"
	printf 'ledger: seeded %s (%s, scale %s)\n' "$slug" "$currency" "$scale"
}

seed_plane() {
	local url stored
	url="$(database_url PLANE_DATABASE_URL)"
	psql "$url" -X -v ON_ERROR_STOP=1 -q \
		-v slug="$slug" -v currency="$currency" -v scale="$scale" -v country="$country" \
		-v cash="$cash" -v fee="$fee" -v receivable="$receivable" -v clearing="$clearing" \
		<<'SQL'
		INSERT INTO ledgers (slug, currency, scale, country_code, is_country_default)
		VALUES (:'slug', :'currency', :'scale', nullif(:'country', ''), :'country' <> '')
		ON CONFLICT (slug) DO NOTHING;

		INSERT INTO platform_accounts (ledger, label, ledger_account_ref)
		VALUES
			(:'slug', 'cash', :'cash'),
			(:'slug', 'fee', :'fee'),
			(:'slug', 'receivable', :'receivable'),
			(:'slug', 'payouts_clearing', :'clearing')
		ON CONFLICT (ledger, label) DO NOTHING;
SQL
	stored="$(psql "$url" -X -v ON_ERROR_STOP=1 -A -t -F ' ' -v slug="$slug" <<'SQL'
		SELECT currency, scale, coalesce(country_code, '-'), is_country_default
		FROM ledgers
		WHERE slug = :'slug';
SQL
	)"
	check_stored plane "$stored" "$currency $scale ${country:--} $([[ -n $country ]] && printf t || printf f)"
	printf 'plane: seeded %s (%s, scale %s, country %s)\n' "$slug" "$currency" "$scale" "${country:--}"
}

for target in "${targets[@]}"; do
	"seed_$target"
done
