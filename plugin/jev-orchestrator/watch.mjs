#!/usr/bin/env node
// Live, free view of what a jev_run is doing right now.
//
//   node watch.mjs            follow until Ctrl-C
//   node watch.mjs --once     print the recent history and exit
//   node watch.mjs --poll 1000
//
// Four local sources, all of them already written by tools that ran anyway, so
// watching costs no model call and no quota:
//   1. 9Router's usageHistory - every upstream call (planner/worker/reviewer),
//      with prompt/completion tokens and the USD cost. This is where the real
//      numbers live: streaming calls record 0/0 in requestDetails.tokens, so
//      watch.mjs reads tokens and dollars ONLY from usageHistory, never from
//      requestDetails (which only has latency and status).
//   2. ~/.dsh/jev-ledger.json - the day's spend per route, written on every charge
//      (so the Jev quota counter moves here in real time).
//   3. ~/.dsh/jev-runs.jsonl  - finished runs, appended at the end of each run.
//   4. ~/.dsh/jev-steps.jsonl - one line per pipeline transition (started/done/test/gate/...),
//      polled by byte offset like jev-runs.jsonl, printed as `HH:MM:SS  step   <text>`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME || homedir();
const DSH = process.env.DSH_HOME || join(HOME, ".dsh");
const LEDGER = join(DSH, "jev-ledger.json");
const RUNS = join(DSH, "jev-runs.jsonl");
const STEPS = join(DSH, "jev-steps.jsonl");
const NINE = process.env.JEV_9ROUTER_DB || join(HOME, ".9router", "db", "data.sqlite");

const argv = process.argv.slice(2);
const once = argv.includes("--once");
const pollMs = Number(argv[argv.indexOf("--poll") + 1]) || 2000;
const sinceMs = Date.now() - (once ? 6 * 3600_000 : 0);

const stamp = (t) => new Date(t).toISOString().slice(11, 19);
const line = (s) => process.stdout.write(s + "\n");

// --- 1. 9Router usageHistory --------------------------------------------------
let db = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  if (existsSync(NINE)) db = new DatabaseSync(NINE, { readOnly: true });
} catch (err) {
  line(`(9Router log unavailable: ${err.message}; ledger and runs still shown)`);
}
let lastUsageId = 0;
let runningTotal = 0;

function pollRouter() {
  if (!db) return;
  let rows = [];
  try {
    // Tokens and dollars come from usageHistory (streaming rows record 0/0 in requestDetails).
    // The optional id > lastUsageId makes this incremental, so a long-running watch stays cheap.
    rows = db.prepare(
      "SELECT id, provider, model, promptTokens, completionTokens, cost, timestamp " +
      "FROM usageHistory WHERE id > ? ORDER BY id ASC LIMIT 50"
    ).all(lastUsageId);
  } catch { return; }
  for (const r of rows) {
    lastUsageId = Math.max(lastUsageId, Number(r.id) || 0);
    const cost = Number(r.cost) || 0;
    runningTotal += cost;
    const pt = Number(r.promptTokens) || 0;
    const ct = Number(r.completionTokens) || 0;
    line(`${stamp(Date.parse(r.timestamp) || Date.now())}  call   ${String(r.provider).padEnd(11)} ${String(r.model).padEnd(22)} $${cost.toFixed(4)}  ${pt}/${ct} tok`);
  }
  // Show the rolling total at most once per second so it doesn't drown the screen.
  if (runningTotal > 0 && rows.length) {
    line(`${stamp(Date.now())}  total  $${runningTotal.toFixed(4)} since this watcher started`);
  }
}

// --- 2. ledger --------------------------------------------------------------
let lastLedger = "";
function pollLedger() {
  try {
    const raw = readFileSync(LEDGER, "utf8").trim();
    if (raw === lastLedger) return;
    lastLedger = raw;
    const d = JSON.parse(raw);
    line(`${stamp(Date.now())}  spend  day ${d.day}  ${Object.entries(d.used || {}).map(([k, v]) => `${k}=${v}`).join("  ") || "(nothing yet)"}`);
  } catch { /* no ledger yet */ }
}

// --- 3. finished runs -------------------------------------------------------
let runOffset = existsSync(RUNS) ? statSync(RUNS).size : 0;
if (once && existsSync(RUNS)) {
  const lines = readFileSync(RUNS, "utf8").trim().split("\n").slice(-5);
  for (const l of lines) {
    try {
      const d = JSON.parse(l);
      line(`${stamp(Date.parse(d.ts))}  run    ${d.status}  ${String(d.task || "").slice(0, 70)}`);
    } catch { /* ignore */ }
  }
}
function pollRuns() {
  if (!existsSync(RUNS)) return;
  const size = statSync(RUNS).size;
  if (size <= runOffset) return;
  const raw = readFileSync(RUNS, "utf8").slice(runOffset);
  runOffset = size;
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const d = JSON.parse(l);
      const roles = (d.trace || []).map((t) => `${t.role}:${t.status}`).join(" ");
      line(`${stamp(Date.parse(d.ts))}  run    ${d.status}  ${String(d.task || "").slice(0, 60)}`);
      if (roles) line(`${stamp(Date.parse(d.ts))}  trace  ${roles}`);
      for (const t of d.trace || []) {
        if (t.role === "laya") line(`${stamp(Date.parse(t.ts || d.ts))}  jev    ${t.label} -> ${t.detail} (${t.source || "?"}, ${t.ms}ms${t.tokensIn ? `, ${t.tokensIn} tok` : ""})`);
      }
    } catch { /* ignore a partial line */ }
  }
}

// --- 4. step feed ----------------------------------------------------------
// Polled by byte offset, exactly like runs: only new bytes are read, so the file is read at most once per tick.
let stepOffset = existsSync(STEPS) ? statSync(STEPS).size : 0;
function pollSteps() {
  if (!existsSync(STEPS)) return;
  const size = statSync(STEPS).size;
  if (size <= stepOffset) return;
  const raw = readFileSync(STEPS, "utf8").slice(stepOffset);
  stepOffset = size;
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      line(`${stamp(Date.parse(e.ts) || Date.now())}  step   ${String(e.text || "").slice(0, 160)}`);
    } catch { /* ignore a torn line */ }
  }
}

line(`watching: ${NINE}\n          ${LEDGER}\n          ${RUNS}\n          ${STEPS}\n(reads only; no model call, no quota)\n`);
pollRouter(); pollLedger(); pollRuns(); pollSteps();
if (once) process.exit(0);
setInterval(() => { pollRouter(); pollLedger(); pollRuns(); pollSteps(); }, pollMs);