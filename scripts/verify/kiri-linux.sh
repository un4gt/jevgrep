#!/usr/bin/env bash
# Dedicated keyring and bus for an installed A package. Keep the instance after logout.
set -euo pipefail
install=${1:?A installation required}; shift
[[ -f "$install/node_modules/@emrank/jevgrep/dist/bin/index.js" && "$install" == "$HOME/.local/share/jg-kiri-a/"*/installed ]] || exit 2
umask 077
export EMRANK_HOME="$install/credentials" XDG_CONFIG_HOME="$install/config" XDG_CACHE_HOME="$install/cache" XDG_DATA_HOME="$install/data" XDG_RUNTIME_DIR="$install/runtime" EMRANK_PROVIDER=emrank
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$EMRANK_HOME"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" GNOME_KEYRING_CONTROL="$XDG_RUNTIME_DIR/keyring"
(
  flock 9
  if ! dbus-send --session --type=method_call --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.ListNames >/dev/null 2>&1; then
    dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS" 9>&- </dev/null >/dev/null 2>&1
  fi
  if [[ ! -f "$install/keyring-unlock" ]]; then head -c 32 /dev/urandom | base64 | tr -d '\n' > "$install/keyring-unlock"; fi
  gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" < "$install/keyring-unlock" 9>&- >/dev/null 2>&1
) 9>"$install/keyring.lock"
exec node "$install/node_modules/@emrank/jevgrep/dist/bin/index.js" "$@"
