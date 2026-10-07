#!/usr/bin/env bash
# Install david plugin into a DeepSeek Harness profile. Safe to re-run.
# (Named "jev-orchestrator" up to 0.7.x: an install under that name is renamed in place.)
#
#   ./install.sh [--profile desktop] [--keepalive] [--no-check]
#
# Changes only: <profile>/plugins/david-plugin, one marked block appended to
# <profile>/cordis.patch.yml (backed up first), $DSH_HOME/PLUGIN-TEMPLATE.md and,
# with --keepalive, one LaunchAgent that keeps Laya running.
# JEV_SKIP_LAUNCHCTL=1 writes the plist but leaves launchd alone (for tests).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
DSH_BIN=${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}
PROFILE=desktop
KEEPALIVE=0
CHECK=1

while [ $# -gt 0 ]; do
  case $1 in
    --profile) PROFILE=$2; shift 2 ;;
    --keepalive) KEEPALIVE=1; shift ;;
    --no-check) CHECK=0; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

PDIR=$DSH_HOME/profiles/$PROFILE
PATCH=$PDIR/cordis.patch.yml
DEST=$PDIR/plugins/david-plugin
[ -d "$PDIR" ] || { echo "no such profile directory: $PDIR" >&2; exit 1; }
case $DEST in */plugins/david-plugin) ;; *) echo "refusing odd destination: $DEST" >&2; exit 1 ;; esac

# An install from before the rename: the same plugin under its old name.
OLD_DEST=$PDIR/plugins/jev-orchestrator

# 1. plugin files
# `|| true`: with set -e and pipefail a missing package.json (first install) would end the script here.
version_of() { { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null || true; } | head -1; }
OLD_VERSION=$(version_of "$DEST"); [ -n "$OLD_VERSION" ] || OLD_VERSION=$(version_of "$OLD_DEST")
NEW_VERSION=$(version_of "$HERE/plugin/david-plugin")
mkdir -p "$PDIR/plugins"
rm -rf "$DEST"
cp -R "$HERE/plugin/david-plugin" "$DEST"
echo "plugin copied to $DEST"
case $OLD_DEST in
  */plugins/jev-orchestrator) if [ -d "$OLD_DEST" ]; then rm -rf "$OLD_DEST"; echo "removed the old copy $OLD_DEST (now $DEST)"; fi ;;
esac
if [ -z "$OLD_VERSION" ]; then echo "version: new install, ${NEW_VERSION:-unknown}"
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then echo "version: ${NEW_VERSION} (same version reinstalled)"
else echo "version: ${OLD_VERSION} -> ${NEW_VERSION}"; fi

# 2. patch entry (idempotent, marked, backed up)
touch "$PATCH"
if grep -q 'jev-orchestrator:begin' "$PATCH"; then
  # Rename the block IN PLACE. It is where the owner's routes, budgets and chains live, so it must never be
  # replaced by the template: only the id, the plugin path and the two markers change.
  BACKUP=$PATCH.bak-rename-$(date +%Y%m%d%H%M%S)
  cp "$PATCH" "$BACKUP"
  sed -E \
    -e 's|^# jev-orchestrator:begin$|# david-plugin:begin|' \
    -e 's|^# jev-orchestrator:end$|# david-plugin:end|' \
    -e 's|^( *- id: )jev-orchestrator$|\1david-plugin|' \
    -e 's|^( *name: \./plugins/)jev-orchestrator(/index\.js)$|\1david-plugin\2|' \
    "$BACKUP" > "$PATCH"
  echo "patch entry renamed jev-orchestrator -> david-plugin in $PATCH (backup: $BACKUP)"
elif grep -q 'david-plugin:begin' "$PATCH"; then
  echo "patch entry already present in $PATCH"
else
  if grep -q '^\[\]' "$PATCH"; then
    echo "$PATCH is an inline empty list; convert it to a block list first" >&2
    exit 1
  fi
  BACKUP=$PATCH.bak-jev-$(date +%Y%m%d%H%M%S)
  cp "$PATCH" "$BACKUP"
  if [ -s "$PATCH" ] && [ -n "$(tail -c1 "$PATCH")" ]; then echo >> "$PATCH"; fi
  cat "$HERE/patch/david-plugin.patch.yml" >> "$PATCH"
  echo "patch entry appended to $PATCH (backup: $BACKUP)"
fi

# 3. the plugin template, kept next to the Harness profiles
cp "$HERE/PLUGIN-TEMPLATE.md" "$DSH_HOME/PLUGIN-TEMPLATE.md"

# 4. the routes the plugin uses must exist in the profile
for needle in 'router9:' 'deepseek-host:' 'id: codex-head' 'id: cursor-workers' 'id: manager-temp' 'id: backup-free' 'id: deepseek-v4.1-flash'; do
  grep -q -- "$needle" "$PATCH" || echo "WARNING: '$needle' not found in $PATCH; edit routes in the david-plugin config block or the plugin will call a missing model" >&2
done

# 5. check the patch with the Harness's own CLI, in a throwaway home (nothing real is touched)
if [ "$CHECK" = 1 ]; then
  if [ ! -x "$DSH_BIN" ]; then
    echo "check skipped: dsh not found at $DSH_BIN"
  else
    T=$(mktemp -d)
    mkdir -p "$T/p/plugins" "$T/home"
    cp -R "$HERE/plugin/david-plugin" "$T/p/plugins/"
    cp "$HERE/patch/david-plugin.patch.yml" "$T/p/extra.yml"
    ( DSH_HOME=$T/home "$DSH_BIN" --profile web --patch "$T/p/extra.yml" --dump-config >"$T/dump.yml" 2>"$T/dump.err" ) &
    PID=$!
    for _ in $(seq 1 60); do kill -0 $PID 2>/dev/null || break; sleep 1; done
    kill $PID 2>/dev/null || true
    if grep -q 'id: david-plugin' "$T/dump.yml" && ! grep -i 'david-plugin' "$T/dump.err" | grep -q -i -E 'error|skipp|unknown'; then
      echo "OK: the Harness accepts the patch entry"
    else
      echo "CHECK FAILED; see $T/dump.err" >&2
      exit 1
    fi
    rm -rf "$T"
  fi
fi

# 6. keep Laya running
if [ "$KEEPALIVE" = 1 ]; then
  mkdir -p "$DSH_HOME/jev"
  cp "$HERE/scripts/laya-keepalive.sh" "$DSH_HOME/jev/laya-keepalive.sh"
  chmod +x "$DSH_HOME/jev/laya-keepalive.sh"
  PLIST=$HOME/Library/LaunchAgents/com.jev.laya-keepalive.plist
  mkdir -p "$HOME/Library/LaunchAgents"
  sed "s|REPLACE_SCRIPT|$DSH_HOME/jev/laya-keepalive.sh|" "$HERE/scripts/com.jev.laya-keepalive.plist" > "$PLIST"
  if [ -z "${JEV_SKIP_LAUNCHCTL:-}" ]; then
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  echo "Laya keepalive installed ($PLIST)"
fi

echo
echo "Done. Restart DeepSeek Harness, then confirm the tool jev_run is available."
