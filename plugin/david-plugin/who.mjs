#!/usr/bin/env node
// Who did the plugin run? Reads the run log written by jev_run and, when 9Router's
// database is present, lists what 9Router itself received during each run.
//
//   node who.mjs [N]        last N runs (default 1)
//
// Env: JEV_RUN_LOG (default ~/.dsh/jev-runs.jsonl), ROUTER9_DB (default ~/.9router/db/data.sqlite)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function readRuns(file, n) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const runs = [];
  for (const l of lines) {
    try {
      runs.push(JSON.parse(l));
    } catch {
      // skip a torn line
    }
  }
  return runs.slice(-n);
}

export function formatRun(run) {
  const out = [`${run.ts}  ${run.status}  ${run.cwd}${run.version ? `  (plugin ${run.version})` : ""}`, `  task: ${run.task}`];
  if (run.error) out.push(`  error: ${run.error}`);
  const ran = new Set();
  for (const e of run.trace ?? []) {
    ran.add(e.role);
    if (e.role === "laya") {
      out.push(`  laya ${e.label}: ${e.status === "ok" ? `p=${e.detail}` : "unavailable"}`);
    } else {
      out.push(`  ${e.label} -> ${e.provider}/${e.model} [${e.key}${e.fellBack ? ", fallback" : ""}${e.status === "error" ? ", FAILED" : e.status === "cancelled" ? ", CANCELLED" : ""}] ${(e.ms / 1000).toFixed(1)}s${(e.status === "error" || e.status === "cancelled") && e.error ? ` (${e.error.replace(/\s+/g, " ").slice(0, 90)})` : ""}`);
    }
  }
  const idle = ["planner", "researcher", "worker", "reviewer", "final_reviewer"].filter((r) => !ran.has(r));
  if (idle.length) out.push(`  not called: ${idle.join(", ")}`);
  return out.join("\n");
}

// Rows 9Router logged between the run's start and end, +-5 s. Timestamps are
// validated before they go into the query.
export function windowSql(startIso, endIso) {
  if (!ISO.test(startIso) || !ISO.test(endIso)) throw new Error("bad timestamp in run log");
  const pad = (iso, s) => new Date(Date.parse(iso) + s * 1000).toISOString();
  return (
    "select provider, model, count(*) n, sum(promptTokens) prompt_tok, sum(completionTokens) out_tok " +
    `from usageHistory where timestamp >= '${pad(startIso, -5)}' and timestamp <= '${pad(endIso, 5)}' ` +
    "group by provider, model order by n desc"
  );
}

export function router9Window(db, run) {
  const raw = execFileSync("sqlite3", ["-readonly", "-json", db, windowSql(run.ts, run.end)], { encoding: "utf8" }).trim();
  return raw ? JSON.parse(raw) : [];
}

function main() {
  const n = Math.max(1, Number(process.argv[2]) || 1);
  const file = process.env.JEV_RUN_LOG ?? join(homedir(), ".dsh", "jev-runs.jsonl");
  const db = process.env.ROUTER9_DB ?? join(homedir(), ".9router", "db", "data.sqlite");
  if (!existsSync(file)) {
    console.error(`no run log at ${file}: jev_run has not completed a run yet`);
    process.exit(1);
  }
  for (const run of readRuns(file, n)) {
    console.log(formatRun(run));
    if (existsSync(db)) {
      try {
        const rows = router9Window(db, run);
        console.log("  9Router received in that window (may include other traffic):");
        console.log(rows.length ? rows.map((r) => `    ${r.provider}/${r.model}  x${r.n}  ${r.prompt_tok} in / ${r.out_tok ?? 0} out tok`).join("\n") : "    (nothing)");
      } catch (err) {
        console.log(`  9Router lookup failed: ${err.message.split("\n")[0]}`);
      }
    }
    console.log();
  }
}

// realpath on both sides: import.meta.url is resolved, argv[1] is not (macOS /tmp -> /private/tmp)
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
