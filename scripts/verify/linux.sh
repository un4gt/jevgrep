#!/usr/bin/env bash
set -euo pipefail
# Called inside dbus-run-session. No login/keyring belonging to a developer is used.
ci_home="$(mktemp -d)"
export XDG_CONFIG_HOME="$ci_home/config"
export XDG_DATA_HOME="$ci_home/data"
export XDG_RUNTIME_DIR="$ci_home/runtime"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
printf '%s' 'ephemeral-ci-keyring' | gnome-keyring-daemon --foreground --unlock --components=secrets &
keyring_pid=$!
trap 'kill "$keyring_pid" 2>/dev/null || true; rm -rf -- "$ci_home"' EXIT
if (( $# )); then
  "$@"
else
  bun run verify
fi
