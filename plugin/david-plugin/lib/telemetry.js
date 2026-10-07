// Read-only view of the four free sources that david_watch and the live HTML dashboard
// show. Every function degrades to zero / empty on missing, unreadable or half-written
// inputs and never throws, so a broken log can never break the run that is reading it.
//
//   1. ~/.dsh/david-steps.jsonl    one line per pipeline transition
//   2. ~/.dsh/david-runs.jsonl     one line per finished run
//   3. ~/.dsh/david-ledger.json    today's per-route spend
//   4. ~/.9router/db/data.sqlite 9Router's read-only usageHistory + usageDaily
//
// All paths follow the same conventions as lib/cost.js, lib/steps.js and watch.mjs:
// env vars DSH_HOME, DAVID_9ROUTER_DB override the defaults; "~/" is expanded.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Path resolution and tiny helpers
// ---------------------------------------------------------------------------

function expandHome(p) {
  return typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

const HOME = process.env.HOME || homedir();
const DSH = process.env.DSH_HOME || join(HOME, ".dsh");
export const LEDGER_FILE = process.env.DAVID_LEDGER_FILE || join(DSH, "david-ledger.json");
export const RUNS_FILE = process.env.DAVID_RUNS_FILE || join(DSH, "david-runs.jsonl");
export const STEPS_FILE = process.env.DAVID_STEPS_FILE || join(DSH, "david-steps.jsonl");
export const NINE_DB = process.env.DAVID_9ROUTER_DB || join(HOME, ".9router", "db", "data.sqlite");

const fileSize = (p) => { try { return statSync(p).size; } catch { return 0; } };
const safeRead = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const safeParse = (line) => { try { return JSON.parse(line); } catch { return null; } };

// ---------------------------------------------------------------------------
// Step file: byte-offset tailing, defensively parsed
// ---------------------------------------------------------------------------

// Parse a string of raw step lines. A trailing line with no newline is reported as
// `unterminated` so the caller knows to retain it for the next call.
function splitStepLines(raw) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) !== 10) continue; // \n
    const slice = raw.slice(start, i);
    if (slice.length > 0) {
      const entry = safeParse(slice);
      if (entry) lines.push(entry);
    }
    start = i + 1;
  }
  const tail = raw.slice(start);
  return { lines, unterminated: tail.length > 0 ? tail : null };
}

// Read the most-recent `limit` parsed step entries. Optional `runId` keeps only
// lines that share that run's identifier, so a stale run does not crowd the
// dashboard. count is independent of the `limit` cap and reflects what's on disk.
export function readSteps({ limit = 200, runId } = {}) {
  const raw = safeRead(STEPS_FILE);
  if (!raw) return { lines: [], count: 0, runId: runId ?? null };
  const { lines } = splitStepLines(raw);
  const filtered = runId ? lines.filter((e) => e && e.run === runId) : lines;
  const cap = Math.max(0, Math.min(2000, Number(limit) || 0));
  return { lines: filtered.slice(-cap), count: filtered.length, runId: runId ?? null };
}

// Byte-offset tail. The caller passes back the offset returned from the previous
// call, and gets every line that was written since. A trailing partial line is
// held back and returned in `unterminated` so the next call picks it up once the
// writer flushes a newline. `offset` advances by the bytes consumed; the unterminated
// bytes are kept out of the count until the next newline lands.
export function tailSteps(offset = 0) {
  if (!existsSync(STEPS_FILE)) return { lines: [], offset: 0, unterminated: "" };
  const size = fileSize(STEPS_FILE);
  const start = Math.max(0, Math.min(size, Number(offset) || 0));
  if (size <= start) return { lines: [], offset: start, unterminated: "" };
  let raw = "";
  try { raw = readFileSync(STEPS_FILE, "utf8").slice(start); } catch { return { lines: [], offset: start, unterminated: "" }; }
  const { lines, unterminated } = splitStepLines(raw);
  const consumed = raw.length - (unterminated ? unterminated.length : 0);
  return { lines, offset: start + consumed, unterminated: unterminated ?? "" };
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

export function readRuns({ limit = 20 } = {}) {
  const raw = safeRead(RUNS_FILE);
  if (!raw) return { lines: [], count: 0 };
  const lines = [];
  for (const l of raw.split("\n")) {
    if (!l) continue;
    const entry = safeParse(l);
    if (entry) lines.push(entry);
  }
  const cap = Math.max(0, Math.min(500, Number(limit) || 0));
  return { lines: lines.slice(-cap), count: lines.length };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export function readLedger() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = readFileSync(LEDGER_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.day === today && parsed.used && typeof parsed.used === "object") {
      return { day: parsed.day, used: parsed.used };
    }
  } catch { /* missing, corrupt, or stale day: start fresh */ }
  return { day: today, used: {} };
}

// ---------------------------------------------------------------------------
// 9Router: read-only SQLite, node:sqlite may be missing on this Node
// ---------------------------------------------------------------------------

let sqliteOk = false;
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
  sqliteOk = true;
} catch { /* the read methods below all return [] when the driver is missing */ }

export function readUsage({ limit = 10 } = {}) {
  if (!sqliteOk || !DatabaseSync || !existsSync(NINE_DB)) return { lines: [], ok: false };
  let db;
  try { db = new DatabaseSync(NINE_DB, { readOnly: true }); }
  catch { return { lines: [], ok: false }; }
  try {
    const n = Math.max(1, Math.min(500, Number(limit) || 10));
    const rows = db.prepare(
      "SELECT timestamp, provider, model, promptTokens, completionTokens, cost " +
      "FROM usageHistory ORDER BY id DESC LIMIT ?"
    ).all(n);
    const lines = rows.map((r) => ({
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      promptTokens: Number(r.promptTokens) || 0,
      completionTokens: Number(r.completionTokens) || 0,
      cost: Number(r.cost) || 0,
    }));
    return { lines, ok: true };
  } catch { return { lines: [], ok: false }; }
  finally { try { db.close(); } catch { /* read-only handle */ } }
}

async function dayUsd() {
  if (!sqliteOk || !DatabaseSync || !existsSync(NINE_DB)) return null;
  let db;
  try { db = new DatabaseSync(NINE_DB, { readOnly: true }); } catch { return null; }
  try {
    const dateKey = new Date().toISOString().slice(0, 10);
    const row = db.prepare("SELECT data FROM usageDaily WHERE dateKey = ?").get(dateKey);
    if (!row) return { dateKey, usd: 0, requests: 0 };
    const d = JSON.parse(row.data);
    return { dateKey, usd: Number(d.cost) || 0, requests: Number(d.requests) || 0 };
  } catch { return null; }
  finally { try { db.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// Snapshot contract
// ---------------------------------------------------------------------------

// Stage grouping: collapse the current run's step feed into one box per label
// (falling back to `role`, then the literal "run"). A stage is "running" when a
// "started" line exists and no later failed/done line for the same key. A stage
// is "failed" when its last line carries status "error"; otherwise "done".
// Stages keep their first-appearance order, latest route/model/turn/USD, and the
// last `text` line written for them. Never fabricated; missing inputs stay empty.
function groupStages(steps) {
  const order = [];
  const map = new Map();
  for (const e of steps) {
    const key = e.label || e.role || "run";
    let stage = map.get(key);
    if (!stage) {
      stage = {
        key,
        role: e.role ?? null,
        label: e.label ?? key,
        status: "waiting",
        route: null,
        model: null,
        via: null,
        turn: null,
        startedAt: null,
        endedAt: null,
        ms: null,
        usd: 0,
        text: "",
      };
      map.set(key, stage);
      order.push(stage);
    }
    if (e.role) stage.role = e.role;
    if (e.label) stage.label = e.label;
    if (e.route) stage.route = e.route;
    if (e.model) stage.model = e.model;
    if (e.via) stage.via = e.via;
    if (Number.isFinite(e.turn)) stage.turn = e.turn;
    if (Number.isFinite(e.usd)) stage.usd = (stage.usd || 0) + Number(e.usd);
    if (typeof e.text === "string") stage.text = e.text;
    const isStart = /started/.test(String(e.text || ""));
    const isDone = /\bdone\b/.test(String(e.text || "")) && e.status !== "error";
    const isFail = e.status === "error";
    if (isStart) stage.startedAt = e.ts ?? stage.startedAt;
    if (isDone || isFail) stage.endedAt = e.ts ?? stage.endedAt;
    if (stage.startedAt && stage.endedAt) {
      const ms = Date.parse(stage.endedAt) - Date.parse(stage.startedAt);
      if (Number.isFinite(ms) && ms >= 0) stage.ms = ms;
    }
    if (isFail) stage.status = "failed";
    else if (isDone) stage.status = "done";
    else if (isStart) stage.status = "running";
  }
  return order;
}

// Pick the current/latest run: join finished run records with the step feed, then
// choose the most-recent run that still has step lines OR appears in the runs log.
// Persisted identifiers (the run record's `end` timestamp and the steps file's
// `run` key) carry the decision; cumulative totals are never summed across runs.
function selectRun(runs, stepLines) {
  const candidates = new Map();
  for (const r of runs) {
    if (!r || !r.id) continue;
    candidates.set(r.id, { id: r.id, startedAt: r.ts, endedAt: r.end ?? null, status: r.status ?? "done", cwd: r.cwd ?? null, task: r.task ?? "", _seenRunLog: true });
  }
  // Steps carry `run` for every line; the most recent run is the one with the latest ts.
  let activeId = null;
  for (const e of stepLines) {
    if (!e || !e.run) continue;
    if (!activeId) activeId = e.run;
    if (e.ts && (!candidates.has(e.run) || !candidates.get(e.run).startedAt || Date.parse(e.ts) > Date.parse(candidates.get(e.run).startedAt || 0))) {
      const prev = candidates.get(e.run) || {};
      candidates.set(e.run, { ...prev, id: e.run, startedAt: e.ts });
    }
  }
  // Prefer the run that the steps file is still writing into.
  let chosen = null;
  if (activeId && candidates.has(activeId)) chosen = candidates.get(activeId);
  if (!chosen) {
    let best = null;
    for (const c of candidates.values()) {
      const t = Date.parse(c.endedAt || c.startedAt || 0) || 0;
      if (!best || t > best._t) { best = { ...c, _t: t }; }
    }
    chosen = best;
  }
  return chosen ? { id: chosen.id, startedAt: chosen.startedAt, endedAt: chosen.endedAt, status: chosen.status, cwd: chosen.cwd, task: chosen.task } : null;
}

// History (newest first) — used by the sidebar and the CFO panel.
function historyFromRuns(runs) {
  return [...runs].reverse().slice(0, 20).map((r) => ({
    id: r.id ?? null,
    status: r.status ?? "done",
    ts: r.ts ?? null,
    end: r.end ?? null,
    usd: Number(r.cost?.thisTask ?? r.usd ?? 0),
    task: String(r.task ?? "").slice(0, 200),
  }));
}

// CFO per-route joining: skip routes with no budget entry. `remaining <= 0` is
// over the cap; shared between `snapshot()` and `cfoLine()` so the dashboard and
// the CLI agree on the wallet state.
function perRouteBudget(ledger, budgets) {
  const out = [];
  const used = ledger.used || {};
  for (const [key, b] of Object.entries(budgets || {})) {
    if (!b || typeof b.daily !== "number") continue;
    const unit = b.unit === "calls" ? "calls" : "tokens";
    const u = Number(used[key] ?? 0);
    const daily = Number(b.daily);
    const remaining = daily - u;
    out.push({ key, unit, used: u, daily, remaining, over: remaining <= 0 });
  }
  return out;
}

// Join the step feed with the finished-run record of the current run, then count
// the USD the run actually spent (NOT a cumulative sum across every run today).
function runUsd(run, steps) {
  if (!run) return 0;
  const id = run.id;
  let usd = 0;
  for (const e of steps) {
    if (!e || e.run !== id) continue;
    if (Number.isFinite(e.usd)) usd += Number(e.usd);
  }
  return usd;
}

// Public surface. cfg is the resolved plugin config; ledger is the loaded
// ledger object (any object with `.day` and `.used` is fine).
export function snapshot(cfg, ledger) {
  cfg = cfg || {};
  const steps = readSteps({ limit: 300 });
  const runs = readRuns({ limit: 50 });
  const led = ledger ?? readLedger();
  const usage = readUsage({ limit: 10 });
  const nineRouter = usage.ok === true;
  const run = selectRun(runs.lines, steps.lines);
  const runSteps = run ? steps.lines.filter((e) => e && e.run === run.id) : steps.lines;
  const stages = run ? groupStages(runSteps) : [];
  const history = historyFromRuns(runs.lines);
  const cfoPerRoute = perRouteBudget(led, cfg.budgets);
  const overRoutes = cfoPerRoute.filter((r) => r.over).map((r) => r.key);
  return {
    now: new Date().toISOString(),
    sources: {
      steps: fileSize(STEPS_FILE),
      runs: fileSize(RUNS_FILE),
      ledgerDay: led.day,
      nineRouter,
    },
    run: run ? {
      ...run,
      task: String(run.task || "").slice(0, 200),
      usd: runUsd(run, steps.lines),
      taskCap: cfg.cost?.taskUsd ?? null,
      callCap: cfg.cost?.callUsd ?? null,
      stages,
    } : null,
    history,
    cfo: {
      today: null, // filled in async wrapper below
      perRoute: cfoPerRoute,
      wallet: overRoutes.length > 0 ? "OVER CAP" : "OK",
      overRoutes,
    },
    steps: steps.lines,
    lastNineRouterCalls: usage.lines,
  };
}

// Async variant: snapshot() with today's USD + requests filled in from 9Router.
// This is what the dashboard server calls every tick; the sync variant above is
// for tests and the cheap "just the file state" path.
export async function snapshotAsync(cfg, ledger) {
  const snap = snapshot(cfg, ledger);
  const day = await dayUsd();
  snap.cfo.today = day;
  return snap;
}

// ---------------------------------------------------------------------------
// CFO line for david_watch
// ---------------------------------------------------------------------------

// Build the CFO block david_watch prints near the top. Disabled tracking ->
// "CFO: (cost tracking off)". Same budget/ledger join as snapshot() so the
// dashboard and the CLI agree on the wallet state. "this task" is the USD the
// CURRENT run is accumulating, not a cumulative total across the day: read it
// from the most-recent run's step lines (defensively; the steps file may be torn).
//
// Output shape (cost tracking on):
//   CFO: today $X.XXXX via 9Router (N calls)
//         this task $X.XXXX / cap $X.XX
//         routeA used/daily unit
//         routeB used/daily unit
//         wallet: OK | OVER CAP
export async function cfoLine(cfg, ledger) {
  cfg = cfg || {};
  ledger = ledger ?? readLedger();
  const cost = cfg.cost;
  if (!cost || cost.enabled === false) return ["CFO: (cost tracking off)"];

  const day = await dayUsd();
  const perRoute = perRouteBudget(ledger, cfg.budgets);
  const overRoutes = perRoute.filter((r) => r.over).map((r) => r.key);
  const wallet = overRoutes.length > 0 ? "OVER CAP" : "OK";

  // "this task" = USD accumulated by the most-recent run still being written.
  let taskUsd = 0;
  const { lines } = readSteps({ limit: 600 });
  let latestId = null;
  for (const e of lines) { if (e && e.run) latestId = e.run; }
  for (const e of lines) {
    if (!e || e.run !== latestId) continue;
    if (Number.isFinite(e.usd)) taskUsd += Number(e.usd);
  }

  const header = day ? `CFO: today $${day.usd.toFixed(4)} via 9Router (${day.requests} calls)` : "CFO: today n/a";
  const taskLine = Number.isFinite(cost.taskUsd)
    ? `      this task $${taskUsd.toFixed(4)} / cap $${cost.taskUsd.toFixed(2)}`
    : `      this task $${taskUsd.toFixed(4)}`;
  const routeLines = perRoute.map((r) => `      ${r.key} ${r.used}/${r.daily} ${r.unit}`);
  return [header, taskLine, ...routeLines, `      wallet: ${wallet}`];
}

// ---------------------------------------------------------------------------
// File-size counter used by the dashboard sidebar
// ---------------------------------------------------------------------------

export function stepsLinesOnDisk() {
  if (!existsSync(STEPS_FILE)) return 0;
  const raw = safeRead(STEPS_FILE);
  if (!raw) return 0;
  let n = 0;
  for (let i = 0; i < raw.length; i += 1) if (raw.charCodeAt(i) === 10) n += 1;
  return n;
}