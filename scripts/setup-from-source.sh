#!/usr/bin/env bash
#
# setup-from-source.sh — dựng và chạy 9Router từ chính source này.
#
# VÌ SAO CÓ SCRIPT NÀY
#   Bản cài bằng `npm i -g 9router` bị npm ghi đè mỗi lần cập nhật, nên mọi bản
#   vá trong node_modules/app đều mất sạch. Chạy từ clone này thì code nằm ở
#   src/ — npm global không chạm tới, và launchd tự dựng lại sau khi reboot.
#
# DÙNG (máy mới)
#   git clone https://github.com/lamthaithanhlong/9router.git ~/src/9router
#   ~/src/9router/scripts/setup-from-source.sh
#
# Chạy lại script sau mỗi lần `git pull` để build lại và restart. Idempotent.
#
# TUỲ CHỌN
#   -n, --no-start     Chỉ build, không cài/khởi động agent
#   -s, --skip-build   Bỏ bước build (dùng cli/app đang có)
#       --pull         git pull --ff-only trước khi build
#   -h, --help         In trợ giúp

set -euo pipefail

LABEL="com.9router.autostart"
PORT="${NINEROUTER_PORT:-20128}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_JS="$REPO/cli/cli.js"
APP_DIR="$REPO/cli/app"
DO_PULL=0
DO_BUILD=1
DO_START=1

usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,\} \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--no-start)   DO_START=0; shift ;;
    -s|--skip-build) DO_BUILD=0; shift ;;
    --pull)          DO_PULL=1; shift ;;
    -h|--help)       usage ;;
    *) printf 'Tham số lạ: %s (xem --help)\n' "$1" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pp()   { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch{console.log(s)}})'; }

# ── Kiểm tra đầu vào ─────────────────────────────────────────────
[ "$(id -u)" -ne 0 ] || die "Đừng chạy bằng sudo/root — LaunchAgent phải thuộc user thường."
[ -f "$CLI_JS" ]     || die "Không thấy $CLI_JS — script phải nằm trong <repo>/scripts/."
command -v node >/dev/null || die "Chưa có node trên PATH."
command -v npm  >/dev/null || die "Chưa có npm trên PATH."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Cần node >= 18 (đang có $(node -v))."
ok "repo $REPO · node $(node -v) · npm $(npm -v)"

# ── Pull (tuỳ chọn) ──────────────────────────────────────────────
if [ "$DO_PULL" = 1 ]; then
  step "git pull --ff-only"
  git -C "$REPO" pull --ff-only
fi

# ── Cài phụ thuộc ────────────────────────────────────────────────
step "npm install (app)"
( cd "$REPO" && npm install --no-audit --no-fund )

step "npm install (cli — cần esbuild để bundle MITM)"
( cd "$REPO" && npm --prefix cli install --ignore-scripts --no-audit --no-fund )

# ── Build ────────────────────────────────────────────────────────
if [ "$DO_BUILD" = 1 ]; then
  step "Build CLI từ source (vài phút)"
  ( cd "$REPO" && npm --prefix cli run build )
fi
{ [ -f "$APP_DIR/server.js" ] || [ -f "$APP_DIR/custom-server.js" ]; } \
  || die "Build không tạo ra $APP_DIR/server.js — xem log phía trên."
ok "cli/app sẵn sàng ($(du -sh "$APP_DIR" | cut -f1))"

if [ "$DO_START" = 0 ]; then
  step "Bỏ qua autostart (--no-start). Chạy tay bằng:"
  printf '    node "%s" --tray --skip-update\n' "$CLI_JS"
  exit 0
fi

# ── LaunchAgent: chạy từ source, không tự npm i -g ────────────────
step "Cài LaunchAgent ($LABEL)"
node -e '
  const path = require("path");
  const cli = process.argv[1];
  const { enableAutoStart } = require(path.join(path.dirname(cli), "src/cli/tray/autostart.js"));
  if (!enableAutoStart(cli)) { console.error("enableAutoStart() trả về false"); process.exit(1); }
' "$CLI_JS"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ -f "$PLIST" ] || die "Không ghi được $PLIST"
grep -q "$CLI_JS" "$PLIST" || die "$PLIST không trỏ vào $CLI_JS"
ok "$PLIST"

step "Khởi động lại agent"
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" || true
fi

# ── Nghiệm thu ───────────────────────────────────────────────────
step "Chờ server lên"
CODE=""
for _ in $(seq 1 30); do
  CODE="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)"
  [ "$CODE" = "200" ] && break
  sleep 1
done
[ "$CODE" = "200" ] || die "Server không lên sau 30s — xem /tmp/9router.log và /tmp/9router.error.log"
ok "health 200 · http://localhost:$PORT"

TOKEN="$(node -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  const dir = path.join(process.env.HOME || "", ".9router");
  try {
    const raw = fs.readFileSync(path.join(dir, "machine-id"), "utf8").trim();
    const sec = fs.readFileSync(path.join(dir, "auth", "cli-secret"), "utf8").trim();
    process.stdout.write(crypto.createHash("sha256").update(raw + "9r-cli-auth" + sec).digest("hex").slice(0, 16));
  } catch { /* chưa có phiên CLI nào */ }
' 2>/dev/null || true)"

if [ -n "$TOKEN" ]; then
  step "Kiểm tra headroom (bản vá đọc shebang)"
  curl -s -m 20 -H "x-9r-cli-token: $TOKEN" "http://127.0.0.1:$PORT/api/headroom/status" | pp
else
  warn "Chưa có token CLI — bỏ qua kiểm tra headroom (mở dashboard một lần rồi chạy lại)."
fi

# ── Nhắc cái bẫy còn lại ─────────────────────────────────────────
GLOBAL_PKG="$(npm root -g 2>/dev/null || true)/9router"
if [ -d "$GLOBAL_PKG" ]; then
  printf '\n'
  warn "Vẫn còn bản npm global: $GLOBAL_PKG"
  echo "    Gõ tay '9router' sẽ mở instance thứ hai và có thể giết luôn instance này"
  echo "    (cli.js kill theo tên tiến trình '9router'). Hết hẳn thì:  npm un -g 9router"
fi

printf '\n\033[1;32m✅ Xong.\033[0m 9Router chạy từ %s — npm i -g không còn ảnh hưởng.\n' "$REPO"
echo "   Log: /tmp/9router.log  ·  lỗi: /tmp/9router.error.log"
echo "   Cập nhật về sau:  git -C \"$REPO\" pull --ff-only && \"$REPO/scripts/setup-from-source.sh\""
