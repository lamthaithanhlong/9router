#!/usr/bin/env node
// Live, free view of what a jev_run is doing right now.
//
//   node watch.mjs            follow until Ctrl-C
//   node watch.mjs --once     print the recent history and exit
//   node watch.mjs --poll 1000
//
// Three local sources, all of them already written by tools that ran anyway, so
// watching costs no model call and no quota:
//   1. 9Router's request log  - every child call (planner/worker/reviewer), with
//      latency, tokens and status. This is where a combo shows its real model.
//   2. ~/.dsh/jev-ledger.json - the day's spend per route, written on every charge
//      (so the Jev quota counter moves here in real time).
//   3. ~/.dsh/jev-runs.jsonl  - finished runs, appended at the end of each run.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME || homedir();
const DSH = process.env.DSH_HOME || join(HOME, ".dsh");
const LEDGER = join(DSH, "jev-ledger.json");
const RUNS = join(DSH, "jev-runs.jsonl");
const NINE = process.env.JEV_9ROUTER_DB || join(HOME, ".9router", "db", "data.sqlite");

const argv = process.argv.slice(2);
const once = argv.includes("--once");
const pollMs = Number(argv[argv.indexOf("--poll") + 1]) || 2000;
const sinceMs = Date.now() - (once ? 6 * 3600_000 : 0);

const stamp = (t) => new Date(t).toISOString().slice(11, 19);
const line = (s) => process.stdout.write(s + "\n");

// --- 1. 9Router request log -------------------------------------------------
let db = null;
try {
  const { DatabaseSync } = await import("node:sqlite");
  if (existsSync(NINE)) db = new DatabaseSync(NINE, { readOnly: true });
} catch (err) {
  line(`(9Router log unavailable: ${err.message}; ledger and runs still shown)`);
}
let lastRequest = new Date(sinceMs).toISOString();

function pollRouter() {
  if (!db) return;
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT timestamp, provider, model, data FROM requestDetails WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 50"
    ).all(lastRequest);
  } catch { return; }
  for (const r of rows) {
    lastRequest = r.timestamp;
    let d = {};
    try { d = JSON.parse(r.data); } catch { /* keep the row */ }
    const lat = d.latency?.total ?? "?";
    const tok = d.tokens ? `${d.tokens.prompt_tokens ?? "?"}/${d.tokens.completion_tokens ?? "?"}` : "?/?";
    line(`${stamp(Date.parse(r.timestamp))}  call   ${String(r.provider).padEnd(9)} ${String(r.model).padEnd(22)} ${String(lat).padStart(6)}ms  tok ${tok}  ${d.status ?? ""}`);
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

line(`watching: ${NINE}\n          ${LEDGER}\n          ${RUNS}\n(reads only; no model call, no quota)\n`);
pollRouter(); pollLedger(); pollRuns();
if (once) process.exit(0);
setInterval(() => { pollRouter(); pollLedger(); pollRuns(); }, pollMs);
