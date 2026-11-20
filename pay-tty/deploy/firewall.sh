#!/usr/bin/env bash

# Limits connections to the TUI's SSH port per client address, before they
# reach the container: a flood is dropped here instead of costing the TUI a
# handshake each. The TUI's own limits (apps/tui/src/limits.ts) are tighter and
# decide who gets a session; these only need to be looser than those, so an
# office on one address isn't cut off.
#
# Usage: sudo deploy/firewall.sh apply | remove | status
#        sudo deploy/firewall.sh ban <address> | unban <address> | bans
#
# ban drops everything from an IPv4 address or range (203.0.113.0/24),
# sessions already open included; remove leaves bans alone.
#
# Rules go in Docker's DOCKER-USER chain, which sees published ports after
# Docker rewrites them: they match the container's port, for connections first
# made to the public one, so a container's own outbound traffic isn't counted.
# IPv4 only: the server publishes the port on IPv4 alone (TUI_PUBLISH), since
# Docker relays IPv6 to the container from one internal address, which no
# per-address limit could tell apart. A reboot, or `firewall-cmd --reload`,
# clears the rules; run apply again after either.

set -euo pipefail

# The TUI container's port, and the public one compose publishes to it.
port=2222
public=22
# New connections per address per minute, with a burst on top: twice the TUI's
# 60 session starts, since a session can take a retry or two to connect.
rate=120/minute
burst=60
# Connections per address open at once, above the TUI's 50 sessions.
open=75
tag=pay-tty-tui
banned=pay-tty-ban

usage() {
	printf 'usage: %s apply | remove | status | ban <address> | unban <address> | bans\n' "$0" >&2
}

case ${1:-} in
ban | unban)
	if [[ $# -ne 2 || ! $2 =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]]; then
		printf '%s needs one IPv4 address or range, such as 203.0.113.7 or 203.0.113.0/24\n' "$1" >&2
		exit 2
	fi

	# DOCKER-USER carries the stack's own traffic too, so a slip with the range
	# could cut off plane, the databases, or the Tailscale admin route.
	prefix=32
	[[ $2 == */* ]] && prefix=${2#*/}
	IFS=. read -r a b c d <<<"${2%/*}"

	if ((a > 255 || b > 255 || c > 255 || d > 255 || prefix > 32)); then
		printf '%s is not an IPv4 address or range\n' "$2" >&2
		exit 2
	fi

	if [[ $1 == ban ]]; then
		if ((prefix < 16)); then
			printf 'refusing to ban %s: wider than a /16\n' "$2" >&2
			exit 2
		fi

		if ((a == 0 || a == 10 || a == 127 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254))); then
			printf 'refusing to ban %s: a private or internal range, which the stack itself uses\n' "$2" >&2
			exit 2
		fi
	fi
	;;
*)
	if [[ $# -ne 1 ]]; then
		usage
		exit 2
	fi
	;;
esac

if [[ $EUID -ne 0 ]]; then
	printf 'run as root: sudo %s %s\n' "$0" "$1" >&2
	exit 1
fi

tables=(iptables)

if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
	printf '%s finds no DOCKER-USER chain: Docker is stopped, or uses another firewall backend (%s)\n' \
		"$(command -v iptables)" "$(readlink -f "$(command -v iptables)")" >&2
	exit 1
fi

ours() {
	"$1" -S DOCKER-USER | grep -- "--comment \"\\?$tag" || true
}

# A ban for exactly this address or range, as iptables would write it.
ban_rule() {
	printf '%s' "-s $1 -m comment --comment $banned -j DROP"
}

bans() {
	"$1" -S DOCKER-USER | grep -- "--comment \"\?$banned" || true
}

# Deletes ours by line number, first match each time: iptables prints a rule
# back in its own form (120/minute as 2/sec), so the text can't be replayed.
remove() {
	local tool=$1 line
	while line=$("$tool" -n -L DOCKER-USER --line-numbers | awk -v tag="$tag" 'index($0, tag) { print $1; exit }') && [[ -n $line ]]; do
		"$tool" -D DOCKER-USER "$line"
	done
}

apply() {
	local tool=$1
	remove "$tool"
	# Each is inserted at the top, so the chain ends up with the open-connection
	# check first, then the rate, both ahead of Docker's own rules.
	"$tool" -I DOCKER-USER -p tcp --dport "$port" -m conntrack --ctstate NEW --ctorigdstport "$public" \
		-m hashlimit --hashlimit-above "$rate" --hashlimit-burst "$burst" \
		--hashlimit-mode srcip --hashlimit-name pay-tty-tui \
		-m comment --comment "$tag: too many new connections" -j DROP
	"$tool" -I DOCKER-USER -p tcp --dport "$port" -m conntrack --ctstate NEW --ctorigdstport "$public" \
		-m connlimit --connlimit-above "$open" \
		-m comment --comment "$tag: too many open connections" -j REJECT --reject-with tcp-reset
}

case $1 in
apply)
	for tool in "${tables[@]}"; do
		apply "$tool"
		printf '%s: applied\n' "$tool"
	done
	;;
remove)
	for tool in "${tables[@]}"; do
		remove "$tool"
		printf '%s: removed\n' "$tool"
	done
	;;
status)
	for tool in "${tables[@]}"; do
		printf '%s limits:\n' "$tool"
		rules=$(ours "$tool")
		printf '%s\n' "${rules:-  none}"
		printf '%s bans:\n' "$tool"
		rules=$(bans "$tool")
		printf '%s\n' "${rules:-  none}"
	done
	;;
ban)
	# shellcheck disable=SC2046 # the rule's words are meant to split
	if iptables -C DOCKER-USER $(ban_rule "$2") 2>/dev/null; then
		printf '%s is already banned\n' "$2"
	else
		# shellcheck disable=SC2046
		iptables -I DOCKER-USER $(ban_rule "$2")
		printf 'banned %s\n' "$2"
	fi
	;;
unban)
	# shellcheck disable=SC2046
	if iptables -D DOCKER-USER $(ban_rule "$2") 2>/dev/null; then
		printf 'unbanned %s\n' "$2"
	else
		printf '%s is not banned\n' "$2" >&2
		exit 1
	fi
	;;
bans)
	rules=$(bans iptables)
	printf '%s\n' "${rules:-none}"
	;;
*)
	usage
	exit 2
	;;
esac
