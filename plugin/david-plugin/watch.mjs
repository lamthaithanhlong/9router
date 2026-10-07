#!/usr/bin/env node
// Live, free view of what a david_run is doing right now.
//
//   node watch.mjs            follow until Ctrl-C
//   node watch.mjs --once     print the recent history and exit
//   node watch.mjs --poll 1000
//
// Four local sources, all of them already written by tools that ran anyway, so
// watching costs no model call and no quota:
//   1. 9Router's usageHistory - every upstream call (planner/worker/reviewer),
//      with prompt/completion tokens and the USD cost. Tokens and dollars come
//      ONLY from usageHistory; streaming rows record 0/0 in requestDetails.
//   2. ~/.dsh/david-ledger.json - the day's spend per route, written on every charge.
//   3. ~/.dsh/david-runs.jsonl  - finished runs, appended at the end of each run.
//   4. ~/.dsh/david-steps.jsonl - one line per pipeline transition, tailed by byte
//      offset so the file is read at most once per tick. The reader lives in
//      `lib/telemetry.js` (same helper the HTML dashboard uses), so a torn
//      trailing line is held back here and shown only when the writer flushes.
import { existsSync, readFileSync, statSync } from "node:fs";
import { tailSteps, STEPS_FILE, RUNS_FILE, LEDGER_FILE } from "./lib/telemetry.js";
import { migrateLegacyFiles } from "./lib/legacy.js";

// This viewer may be the first thing to run after the 0.9.0 rename: bring the old history across before reading.
migrateLegacyFiles([LEDGER_FILE, RUNS_FILE, STEPS_FILE]);

const argv = process.argv.slice(2);
const once = argv.includes("--once");
const pollMs = Number(argv[argv.indexOf("--poll") + 1]) || 2000;

const stamp = (t) => new Date(t).toISOString().slice(11, 19);
// Older than today: say which day, or 09:00 yesterday reads as 09:00 now.
const stampDay = (t) => (new Date(t).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10) ? stamp(t) : new Date(t).toISOString().slice(5, 19).replace("T", " "));
const line = (s) => process.stdout.write(s + "\n");

// --- 1. 9Router usageHistory --------------------------------------------------
let db = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const { NINE_DB } = await import("./lib/telemetry.js");
  if (existsSync(NINE_DB)) db = new DatabaseSync(NINE_DB, { readOnly: true });
} catch (err) {
  line(`(9Router log unavailable: ${err.message}; ledger and runs still shown)`);
}
let lastUsageId = 0;
let runningTotal = 0;
// Start at the tail, not at row 1: usageHistory holds days of calls, and replaying the oldest 50 as if
// they were live (time-only stamps, no date) made a run from yesterday look like it was happening now.
// --once shows the last few calls; follow mode shows only what arrives after it starts.
if (db) {
  try {
    const tail = once ? 20 : 0;
    const r = db.prepare("SELECT COALESCE(MAX(id), 0) - ? AS id FROM usageHistory").get(tail);
    lastUsageId = Math.max(0, Number(r?.id) || 0);
  } catch { /* table missing: pollRouter handles it */ }
}

function pollRouter() {
  if (!db) return;
  let rows = [];
  try {
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
    line(`${stampDay(Date.parse(r.timestamp) || Date.now())}  call   ${String(r.provider).padEnd(11)} ${String(r.model).padEnd(22)} $${cost.toFixed(4)}  ${pt}/${ct} tok`);
  }
  if (runningTotal > 0 && rows.length) {
    line(`${stamp(Date.now())}  total  $${runningTotal.toFixed(4)} since this watcher started`);
  }
}

// --- 2. ledger --------------------------------------------------------------
let lastLedger = "";
function pollLedger() {
  try {
    const raw = readFileSync(LEDGER_FILE, "utf8").trim();
    if (raw === lastLedger) return;
    lastLedger = raw;
    const d = JSON.parse(raw);
    line(`${stamp(Date.now())}  spend  day ${d.day}  ${Object.entries(d.used || {}).map(([k, v]) => `${k}=${v}`).join("  ") || "(nothing yet)"}`);
  } catch { /* no ledger yet */ }
}

// --- 3. finished runs -------------------------------------------------------
let runOffset = existsSync(RUNS_FILE) ? statSync(RUNS_FILE).size : 0;
if (once && existsSync(RUNS_FILE)) {
  const lines = readFileSync(RUNS_FILE, "utf8").trim().split("\n").slice(-5);
  for (const l of lines) {
    try {
      const d = JSON.parse(l);
      line(`${stamp(Date.parse(d.ts))}  run    ${d.status}  ${String(d.task || "").slice(0, 70)}`);
    } catch { /* ignore */ }
  }
}
function pollRuns() {
  if (!existsSync(RUNS_FILE)) return;
  const size = statSync(RUNS_FILE).size;
  if (size <= runOffset) return;
  const raw = readFileSync(RUNS_FILE, "utf8").slice(runOffset);
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
// tailSteps() handles byte-offset reading AND a torn trailing line. The offset
// it returns already excludes the unterminated bytes, so the next call picks up
// where this one left off and never re-reads the same prefix.
let stepOffset = existsSync(STEPS_FILE) ? statSync(STEPS_FILE).size : 0;
function pollSteps() {
  const out = tailSteps(stepOffset);
  stepOffset = out.offset;
  for (const e of out.lines) {
    line(`${stamp(Date.parse(e.ts) || Date.now())}  step   ${String(e.text || "").slice(0, 160)}`);
  }
}

line(`watching: ${process.env.DAVID_9ROUTER_DB || "~/.9router/db/data.sqlite"}\n          ${LEDGER_FILE}\n          ${RUNS_FILE}\n          ${STEPS_FILE}\n(reads only; no model call, no quota)\n`);
pollRouter(); pollLedger(); pollRuns(); pollSteps();
if (once) process.exit(0);
setInterval(() => { pollRouter(); pollLedger(); pollRuns(); pollSteps(); }, pollMs);