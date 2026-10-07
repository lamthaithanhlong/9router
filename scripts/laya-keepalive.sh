#!/bin/sh
# Start Laya if it is not up. laya-ctl does the real work (health probe, port
# check, background start); this only decides to call it. Run by launchd every minute.
CTL="${LAYA_CTL:-$HOME/.local/bin/laya-ctl}"
[ -x "$CTL" ] || exit 0
"$CTL" status >/dev/null 2>&1 || "$CTL" start
