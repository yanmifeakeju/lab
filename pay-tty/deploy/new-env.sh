#!/usr/bin/env bash

# Writes a fresh .env for the server from deploy/.env.example, with a new random
# value for every secret, replacing any .env there. For a deploy from scratch:
# the database passwords only take effect on a new postgres volume, and new
# token keys sign everyone out.

set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
target="$root_dir/.env"

if ! command -v openssl >/dev/null 2>&1; then
	printf 'openssl is required\n' >&2
	exit 1
fi

hex() { openssl rand -hex "$1"; }

# 32 random bytes, base64url without padding, as plane's token keys take.
token_secret() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; }

# The API key and the webhook secret must differ; plane and the sim refuse to
# start when they match. Two random values always do.
sed \
	-e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 24)|" \
	-e "s|^PLANE_DB_PASSWORD=.*|PLANE_DB_PASSWORD=$(hex 24)|" \
	-e "s|^LEDGER_DB_PASSWORD=.*|LEDGER_DB_PASSWORD=$(hex 24)|" \
	-e "s|^SIM_DB_PASSWORD=.*|SIM_DB_PASSWORD=$(hex 24)|" \
	-e "s|^SIM_API_KEY=.*|SIM_API_KEY=$(hex 32)|" \
	-e "s|^SIM_WEBHOOK_SECRET=.*|SIM_WEBHOOK_SECRET=$(hex 32)|" \
	-e "s|^PLANE_TOKEN_KEYS=.*|PLANE_TOKEN_KEYS=prod:$(token_secret)|" \
	"$root_dir/deploy/.env.example" >"$target"

chmod 600 "$target"
printf 'wrote %s; check the TUI_ and PLANE_SETTLEMENT_DELAY lines\n' "$target"
