# shellcheck shell=bash
# Sourced by the scripts beside it.

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

env_loaded=

# Prints the URL in the named variable, sourcing the root .env first if the
# environment doesn't set it. The environment wins, so a caller can point a
# script at another database.
database_url() {
	local name=$1
	if [[ -z ${!name:-} && -z $env_loaded && -f "$root_dir/.env" ]]; then
		set -a
		# shellcheck disable=SC1091
		source "$root_dir/.env"
		set +a
		env_loaded=1
	fi
	if [[ -z ${!name:-} ]]; then
		printf '%s is not set\n' "$name" >&2
		exit 1
	fi
	printf '%s' "${!name}"
}

require_psql() {
	if ! command -v psql >/dev/null 2>&1; then
		printf 'psql is required\n' >&2
		exit 1
	fi
}

# Sets the array `targets` to the named databases, in the order of the
# space-separated `allowed`; naming none selects all of them.
parse_targets() {
	local -a allowed
	read -r -a allowed <<<"$1"
	shift
	local target
	for target in "$@"; do
		if [[ " ${allowed[*]} " != *" $target "* ]]; then
			printf 'unknown database %q: expected one of %s\n' "$target" "${allowed[*]}" >&2
			exit 2
		fi
	done
	targets=()
	for target in "${allowed[@]}"; do
		if [[ $# -eq 0 || " $* " == *" $target "* ]]; then
			targets+=("$target")
		fi
	done
}
