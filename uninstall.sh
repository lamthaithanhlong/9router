#!/usr/bin/env bash
# Remove david-plugin from a Harness profile. Leaves other patch entries,
# the spend ledger (~/.dsh/david-ledger.json) and PLUGIN-TEMPLATE.md in place.
# DAVID_SKIP_LAUNCHCTL=1 leaves launchd alone (for tests).
#
#   ./uninstall.sh [--profile desktop]
set -euo pipefail

DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE=desktop
while [ $# -gt 0 ]; do
  case $1 in
    --profile) PROFILE=$2; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

PDIR=$DSH_HOME/profiles/$PROFILE
PATCH=$PDIR/cordis.patch.yml

# "jev-orchestrator" is the name up to 0.7.x: remove an install under either name.
for NAME in david-plugin jev-orchestrator; do
  if [ -f "$PATCH" ] && grep -q "# $NAME:begin" "$PATCH"; then
    cp "$PATCH" "$PATCH.bak-david-uninstall-$(date +%Y%m%d%H%M%S)"
    awk -v n="$NAME" 'index($0, "# " n ":begin"){skip=1} !skip{print} index($0, "# " n ":end"){skip=0}' "$PATCH" > "$PATCH.tmp"
    mv "$PATCH.tmp" "$PATCH"
    echo "patch entry ($NAME) removed from $PATCH"
  fi
  DEST=$PDIR/plugins/$NAME
  case $DEST in
    */plugins/david-plugin|*/plugins/jev-orchestrator) if [ -d "$DEST" ]; then rm -rf "$DEST"; echo "removed $DEST"; fi ;;
  esac
done

# The LaunchAgent is one per user, so only remove it when it runs THIS DSH_HOME's script:
# a test run against a temp DSH_HOME once removed the real job.
PLIST=$HOME/Library/LaunchAgents/com.jev.laya-keepalive.plist
KEEPALIVE=$DSH_HOME/jev/laya-keepalive.sh
if [ -f "$PLIST" ] && grep -q -F "$KEEPALIVE" "$PLIST"; then
  [ -n "${DAVID_SKIP_LAUNCHCTL:-}" ] || launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$KEEPALIVE"
  echo "Laya keepalive removed"
fi
echo "Done. Restart DeepSeek Harness."
