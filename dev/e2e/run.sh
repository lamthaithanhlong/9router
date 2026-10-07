#!/usr/bin/env bash
# End-to-end check of the plugin inside the REAL Harness runtime, with a fake model server.
# No API keys, no quota, no change to ~/.dsh: everything lives in a temp dir.
#   dev/e2e/run.sh            (needs the DeepSeek Harness app, node, git)
#   E2E_VERBOSE=1 dev/e2e/run.sh   also prints each scenario's report
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$HERE/../.." && pwd)
DSH_BIN=${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}
PORT=${PORT:-18999}
[ -x "$DSH_BIN" ] || { echo "dsh not found at $DSH_BIN" >&2; exit 2; }
if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy; set PORT=" >&2; exit 2; fi

D=$(cd "$(mktemp -d)" && pwd -P)   # real path: macOS /tmp is a symlink
FAKE_PID=
cleanup() { [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null || true; rm -rf "$D"; }
trap cleanup EXIT

mkdir -p "$D/home" "$D/p/plugins" "$D/ws"
cp -R "$PKG/plugin/jev-orchestrator" "$D/p/plugins/"
write_patch() {  # $1 = scenario. F also makes the child tool filter name a tool the Harness does not have.
  local extra=""
  [ "$1" = F ] && extra="        childTools: { denyAll: [jev_run, subagent, subagent_fork, workflow, bogus_tool_name], denyNonWorker: [write, edit] }"
  cat > "$D/p/extra.yml" <<YML
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: router9, model: manager-temp }
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      router9: { displayName: fake, apiKeyEnv: FAKE_KEY, api: openai-completions, baseURL: "http://127.0.0.1:$PORT/v1", models: [{id: codex-head}, {id: manager-temp}, {id: cursor-workers}, {id: backup-free}, {id: full}] }
      deepseek-host: { apiKeyEnv: FAKE_KEY, api: openai-completions, baseURL: "http://127.0.0.1:$PORT/v1", models: [{id: deepseek-v4.1-flash, name: deepseek-v4.1-flash}] }
- insert:
    - id: jev-orchestrator
      name: ./plugins/jev-orchestrator/index.js
      config:
        runLog: $D/jev-runs.jsonl
        ledgerFile: $D/jev-ledger.json
        laya: { enabled: false }
        limits: { startGapMs: { cursor: 0 } }   # e2e only: the 2 s spacing is unit-tested; here we want overlap
${extra}
YML
}

mkdir "$D/repo" && git -C "$D/repo" init -q && git -C "$D/repo" config user.email t@t && git -C "$D/repo" config user.name t
echo "# repo" > "$D/repo/README.md" && git -C "$D/repo" add -A && git -C "$D/repo" commit -qm init

fail=0
for scen in A B C D E F; do
  write_patch "$scen"
  echo "$scen" > "$D/scenario"
  git -C "$D/repo" reset -q --hard && git -C "$D/repo" clean -fdxq
  rm -f "$D/requests.jsonl" "$D/jev-runs.jsonl" "$D/jev-ledger.json"
  E2E_DIR=$D PORT=$PORT SCRIPT="$HERE/script.mjs" node "$HERE/fake-llm.mjs" > "$D/fake.out" 2>&1 & FAKE_PID=$!
  sleep 1
  ( cd "$D/ws" && DSH_HOME="$D/home" FAKE_KEY=dummy E2E_DIR="$D" "$DSH_BIN" headless --patch "$D/p/extra.yml" "run the smoke task" > "$D/head-$scen.out" 2> "$D/head-$scen.err" ) & HP=$!
  for _ in $(seq 1 120); do kill -0 $HP 2>/dev/null || break; sleep 1; done
  kill $HP 2>/dev/null || true
  kill "$FAKE_PID" 2>/dev/null || true; wait "$FAKE_PID" 2>/dev/null || true; FAKE_PID=
  cp "$D/requests.jsonl" "$D/requests-$scen.jsonl" 2>/dev/null || : > "$D/requests-$scen.jsonl"
  [ -n "${E2E_VERBOSE:-}" ] && { echo "--- scenario $scen: what the head agent received from jev_run"; cat "$D/head-$scen.out"; echo; }
  node "$HERE/check.mjs" "$scen" "$D" || { fail=1; echo "--- head output:"; cat "$D/head-$scen.out"; echo "--- stderr:"; grep -v -E 'DEP0180|trace-deprecation' "$D/head-$scen.err" | head -10; }
done
exit $fail
